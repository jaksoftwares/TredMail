import crypto from "node:crypto";
import fs from "node:fs";
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerOptions, type SMTPServerSession } from "smtp-server";
import { simpleParser } from "mailparser";
import { prisma } from "@tredmail/db";
import { env } from "@tredmail/core/config/env";
import { redisConnection } from "@tredmail/core/queue/redis";
import { hashApiKey } from "@tredmail/core/security/api-keys";
import { hasScope } from "@tredmail/core/security/scopes";
import { acceptEmail } from "@tredmail/core/services/email-service";
import { dispatchWebhookEvent } from "@tredmail/core/webhooks/dispatcher";
import { toSendRequests } from "./convert.js";

/**
 * TredMail SMTP relay: lets any application that can send through SMTP (WordPress, Laravel,
 * Django, legacy systems, Postmark/SendGrid SMTP setups) use TredMail without code changes.
 *
 *   Host smtp.tredmail.dovepeakdigital.com, port 587 (STARTTLS) or 465 (TLS)
 *   Username: anything (e.g. "tredmail")    Password: an API key with emails:send
 *
 * Messages go through the same acceptEmail() as the API: verified domains, suppressions,
 * sandbox rules, templates of nothing, DKIM by the worker.
 */

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const AUTH_FAILURES_BEFORE_LOCK = 10;
const AUTH_LOCK_SECONDS = 15 * 60;

interface AuthedUser {
  organizationId: string;
  apiKeyId: string;
}

const smtpError = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });

async function authFailuresFor(ip: string) {
  return Number((await redisConnection.get(`tredmail:smtp-auth-fail:${ip}`)) ?? 0);
}

async function recordAuthFailure(ip: string) {
  const key = `tredmail:smtp-auth-fail:${ip}`;
  const count = await redisConnection.incr(key);
  if (count === 1) await redisConnection.expire(key, AUTH_LOCK_SECONDS);
}

async function authenticate(auth: SMTPServerAuthentication, session: SMTPServerSession): Promise<AuthedUser> {
  const ip = session.remoteAddress;
  if ((await authFailuresFor(ip)) >= AUTH_FAILURES_BEFORE_LOCK) {
    throw smtpError(454, "4.7.0 Too many failed logins from your address. Try again in 15 minutes.");
  }
  const token = (auth.password ?? "").trim();
  const apiKey = token
    ? await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(token) }, select: { id: true, organizationId: true, scopes: true, revokedAt: true, expiresAt: true } })
    : null;
  const valid = apiKey && !apiKey.revokedAt && !(apiKey.expiresAt && apiKey.expiresAt <= new Date());
  if (!valid) {
    await recordAuthFailure(ip);
    throw smtpError(535, "5.7.8 Authentication failed. Use an API key with the emails:send scope as the password.");
  }
  if (!hasScope(apiKey.scopes, "emails:send")) {
    throw smtpError(535, "5.7.8 This API key lacks the emails:send scope.");
  }
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { organizationId: apiKey.organizationId, apiKeyId: apiKey.id };
}

/** Maps an API rejection to an SMTP reply: temporary conditions are 4xx so clients retry. */
function smtpReplyFor(statusCode: number, error: string, message: string) {
  if (statusCode === 429 || statusCode >= 500) return smtpError(451, `4.3.0 ${error}: ${message}`);
  if (error === "recipient_suppressed") return smtpError(550, `5.1.1 ${error}: ${message}`);
  if (error.startsWith("domain_") || error.startsWith("sandbox_")) return smtpError(550, `5.7.1 ${error}: ${message}`);
  return smtpError(554, `5.6.0 ${error}: ${message}`);
}

/**
 * A client that times out after DATA retries the same message. The Message-ID makes the
 * retry a no-op for 24 hours (same store as the API's Idempotency-Key).
 */
async function claimMessageId(organizationId: string, messageId: string | undefined, raw: Buffer) {
  if (!messageId) return { duplicateOf: null, recordId: null };
  const key = `smtp:${messageId}`.slice(0, 256);
  const requestHash = crypto.createHash("sha256").update(raw).digest("hex");
  const inserted = await prisma.idempotencyKey.createMany({ data: [{ organizationId, key, requestHash }], skipDuplicates: true });
  const record = await prisma.idempotencyKey.findUniqueOrThrow({ where: { organizationId_key: { organizationId, key } } });
  if (inserted.count === 1) return { duplicateOf: null, recordId: record.id };
  const ids = (record.response as { ids?: string[] } | null)?.ids;
  return { duplicateOf: ids ?? [], recordId: null };
}

// smtp-server keeps the authenticated user as a string: "<workspace id>:<api key id>"
const encodeUser = (user: AuthedUser) => `${user.organizationId}:${user.apiKeyId}`;
const decodeUser = (value: string): AuthedUser => {
  const [organizationId, apiKeyId] = value.split(":");
  return { organizationId, apiKeyId };
};

async function handleMessage(raw: Buffer, session: SMTPServerSession): Promise<string> {
  const user = decodeUser(session.user ?? "");
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const claim = await claimMessageId(user.organizationId, parsed.messageId, raw);
  if (claim.duplicateOf) return `2.0.0 Already accepted ${claim.duplicateOf.join(",")}`;

  const requests = toSendRequests(parsed, {
    mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
    rcptTo: session.envelope.rcptTo.map((r) => r.address),
  });
  const ids: string[] = [];
  try {
    for (const request of requests) {
      const result = await acceptEmail(user.organizationId, request);
      if (!result.ok) {
        // Nothing of this message was sent yet only if it was the first part
        if (ids.length === 0) throw smtpReplyFor(result.statusCode, result.error, result.message);
        console.warn(`[smtp] part of a split message was refused: ${result.error}`);
        continue;
      }
      ids.push(result.email.id);
      await dispatchWebhookEvent(user.organizationId, result.email.status === "scheduled" ? "email.scheduled" : "email.queued", {
        email_id: result.email.id,
        from: result.email.from,
        to: result.email.to,
        source: "smtp",
      }).catch(() => undefined);
    }
  } catch (err) {
    if (claim.recordId) await prisma.idempotencyKey.delete({ where: { id: claim.recordId } }).catch(() => undefined);
    throw err;
  }
  if (claim.recordId) {
    await prisma.idempotencyKey.update({ where: { id: claim.recordId }, data: { statusCode: 250, response: { ids } } }).catch(() => undefined);
  }
  return `2.0.0 Queued as ${ids.join(",")}`;
}

function readTls(): { key: Buffer; cert: Buffer } | null {
  if (!env.SMTP_RELAY_TLS_CERT || !env.SMTP_RELAY_TLS_KEY) return null;
  try {
    return { cert: fs.readFileSync(env.SMTP_RELAY_TLS_CERT), key: fs.readFileSync(env.SMTP_RELAY_TLS_KEY) };
  } catch (err) {
    console.warn(`[smtp] TLS certificate not readable yet (${(err as Error).message}); using a temporary self-signed one`);
    return null;
  }
}

function serverOptions(secure: boolean): SMTPServerOptions {
  const tls = readTls();
  return {
    secure,
    name: env.SMTP_RELAY_HOSTNAME,
    banner: "TredMail SMTP relay by Dovepeak Technologies",
    size: MAX_MESSAGE_BYTES,
    authMethods: ["PLAIN", "LOGIN"],
    // Credentials only over TLS, except on a development machine
    allowInsecureAuth: env.NODE_ENV === "development",
    disabledCommands: [],
    maxClients: 200,
    socketTimeout: 60_000,
    ...(tls ?? {}),
    onAuth(auth, session, callback) {
      authenticate(auth, session).then(
        (user) => callback(null, { user: encodeUser(user) }),
        (err) => callback(err),
      );
    },
    onMailFrom(_address, session, callback) {
      if (!session.user) return callback(smtpError(530, "5.7.0 Authentication required"));
      callback();
    },
    onRcptTo(_address, session, callback) {
      if (session.envelope.rcptTo.length >= MAX_RECIPIENTS) {
        return callback(smtpError(452, `4.5.3 At most ${MAX_RECIPIENTS} recipients per message`));
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) {
          return callback(smtpError(552, `5.3.4 Message exceeds ${MAX_MESSAGE_BYTES / 1024 / 1024} MB`));
        }
        handleMessage(Buffer.concat(chunks), session).then(
          // smtp-server replies "250 <message>" when given text (its typings omit the argument)
          (message) => (callback as (err: Error | null, message?: string) => void)(null, message),
          (err: Error & { responseCode?: number }) => {
            if (!err.responseCode) console.error("[smtp] message handling failed", err);
            callback(err.responseCode ? err : smtpError(451, "4.3.0 Temporary failure, try again"));
          },
        );
      });
    },
  };
}

const servers: SMTPServer[] = [];

function listen(port: number, secure: boolean) {
  const server = new SMTPServer(serverOptions(secure));
  server.on("error", (err) => console.error(`[smtp] port ${port} error`, err.message));
  server.listen(port, "0.0.0.0");
  console.log(`[smtp] TredMail SMTP relay listening on ${port}${secure ? " (TLS)" : " (STARTTLS)"}`);
  servers.push(server);
}

listen(env.SMTP_RELAY_PORT, false);
if (env.SMTP_RELAY_TLS_PORT) listen(env.SMTP_RELAY_TLS_PORT, true);
if (!readTls() && env.NODE_ENV === "production") {
  console.warn("[smtp] No TLS certificate configured: clients that verify certificates will refuse to connect.");
}

// Pick up renewed certificates (Caddy renews them every ~60 days; cert-sync copies them).
let lastCertMtime = env.SMTP_RELAY_TLS_CERT && fs.existsSync(env.SMTP_RELAY_TLS_CERT) ? fs.statSync(env.SMTP_RELAY_TLS_CERT).mtimeMs : 0;
const certTimer = setInterval(() => {
  if (!env.SMTP_RELAY_TLS_CERT || !fs.existsSync(env.SMTP_RELAY_TLS_CERT)) return;
  const mtime = fs.statSync(env.SMTP_RELAY_TLS_CERT).mtimeMs;
  if (mtime === lastCertMtime) return;
  const tls = readTls();
  if (!tls) return;
  for (const server of servers) server.updateSecureContext(tls);
  lastCertMtime = mtime;
  console.log("[smtp] TLS certificate reloaded");
}, 10 * 60_000);

const shutdown = async () => {
  clearInterval(certTimer);
  await Promise.allSettled(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await Promise.allSettled([prisma.$disconnect(), redisConnection.quit()]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
