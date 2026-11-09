import crypto from "node:crypto";
import fs from "node:fs";
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerOptions, type SMTPServerSession } from "smtp-server";
import { simpleParser } from "mailparser";
import { prisma } from "@tredmail/db";
import { env } from "@tredmail/core/config/env";
import { redisRequests } from "@tredmail/core/queue/request-redis";
import { hashApiKey, isTestKeyToken } from "@tredmail/core/security/api-keys";
import { hasScope } from "@tredmail/core/security/scopes";
import { sendEmailSchema, type SendEmailInput } from "@tredmail/core/services/email-validation";
import {
  commitSend,
  prepareSend,
  recordRefusedEmail,
  type AcceptResult,
  type PreparedSend,
} from "@tredmail/core/services/email-service";
import { releaseUsage, reserveUsage } from "@tredmail/core/billing/usage";
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
  /** A tred_test_ key: messages are validated and recorded, never delivered */
  testMode: boolean;
}

const smtpError = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });

// Fail open, like the API's limits: an unreachable Redis must not lock out every sender.
async function authFailuresFor(ip: string) {
  return Number((await redisRequests.get(`tredmail:smtp-auth-fail:${ip}`).catch(() => null)) ?? 0);
}

async function recordAuthFailure(ip: string) {
  const key = `tredmail:smtp-auth-fail:${ip}`;
  const count = await redisRequests.incr(key).catch(() => 0);
  if (count === 1) await redisRequests.expire(key, AUTH_LOCK_SECONDS).catch(() => undefined);
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
  return { organizationId: apiKey.organizationId, apiKeyId: apiKey.id, testMode: isTestKeyToken(token) };
}

/** Maps an API rejection to an SMTP reply: temporary conditions are 4xx so clients retry. */
function smtpReplyFor(statusCode: number, error: string, message: string) {
  if (statusCode === 429 || statusCode >= 500) return smtpError(451, `4.3.0 ${error}: ${message}`);
  if (error === "recipient_suppressed") return smtpError(550, `5.1.1 ${error}: ${message}`);
  if (error.startsWith("domain_") || error.startsWith("sandbox_")) return smtpError(550, `5.7.1 ${error}: ${message}`);
  return smtpError(554, `5.6.0 ${error}: ${message}`);
}

/** An unfinished claim older than this means its first attempt died, so the claim can be taken over. */
const STALE_CLAIM_MS = 5 * 60_000;

/**
 * A client that times out after DATA retries the same message. The Message-ID makes the
 * retry a no-op for 24 hours (same store as the API's Idempotency-Key). While the first attempt
 * is still running, the retry is asked to come back later: it must not be answered as accepted,
 * because the first attempt can still fail and release its claim.
 */
async function claimMessageId(
  organizationId: string,
  messageId: string | undefined,
  raw: Buffer,
): Promise<{ duplicateOf: string[] | null; recordId: string | null }> {
  if (!messageId) return { duplicateOf: null, recordId: null };
  const key = `smtp:${messageId}`.slice(0, 256);
  const requestHash = crypto.createHash("sha256").update(raw).digest("hex");
  const inserted = await prisma.idempotencyKey.createMany({ data: [{ organizationId, key, requestHash }], skipDuplicates: true });
  const record = await prisma.idempotencyKey.findUniqueOrThrow({ where: { organizationId_key: { organizationId, key } } });
  if (inserted.count === 1) return { duplicateOf: null, recordId: record.id };
  // Finished: a duplicate, answered with the ids the message was accepted under
  if (record.statusCode !== null) {
    const ids = (record.response as { ids?: string[] } | null)?.ids;
    return { duplicateOf: ids ?? [], recordId: null };
  }
  // Unfinished and recent: the first attempt is still running
  if (Date.now() - record.createdAt.getTime() < STALE_CLAIM_MS) {
    throw smtpError(451, "4.3.0 The first attempt for this message is still being processed. Retry later.");
  }
  // Unfinished for too long: that attempt died. Take the claim over (the delete must succeed,
  // or the retry below would loop).
  await prisma.idempotencyKey.delete({ where: { id: record.id } });
  return claimMessageId(organizationId, messageId, raw);
}

// smtp-server keeps the authenticated user as a string: "<workspace id>:<api key id>:<test 1|0>"
const encodeUser = (user: AuthedUser) => `${user.organizationId}:${user.apiKeyId}:${user.testMode ? 1 : 0}`;
const decodeUser = (value: string): AuthedUser => {
  const [organizationId, apiKeyId, test] = value.split(":");
  return { organizationId, apiKeyId, testMode: test === "1" };
};

/** Announces an accepted part on the same events the API uses (test mail is reported as delivered). */
const announceSmtp = (organizationId: string, result: Extract<AcceptResult, { ok: true }>) =>
  result.email.test
    ? dispatchWebhookEvent(organizationId, "email.delivered", {
        email_id: result.email.id,
        from: result.email.from,
        to: result.email.to,
        source: "smtp",
        test: true,
      })
    : dispatchWebhookEvent(organizationId, result.email.status === "scheduled" ? "email.scheduled" : "email.queued", {
        email_id: result.email.id,
        from: result.email.from,
        to: result.email.to,
        source: "smtp",
      });

async function handleMessage(raw: Buffer, session: SMTPServerSession): Promise<string> {
  const user = decodeUser(session.user ?? "");
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const requests = toSendRequests(parsed, {
    mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
    rcptTo: session.envelope.rcptTo.map((r) => r.address),
  });

  // The same rules as the API. A request that breaks them is a permanent error, so the client
  // does not retry it forever.
  const payloads: SendEmailInput[] = [];
  for (const request of requests) {
    const valid = sendEmailSchema.safeParse(request);
    if (!valid.success) {
      const issue = valid.error.issues[0];
      throw smtpError(554, `5.6.0 ${issue.path.join(".")}: ${issue.message}`);
    }
    payloads.push(valid.data);
  }
  if (payloads.length === 0) throw smtpError(554, "5.1.3 No recipients");

  const claim = await claimMessageId(user.organizationId, parsed.messageId, raw);
  if (claim.duplicateOf) return `2.0.0 Already accepted ${claim.duplicateOf.join(",")}`;

  const ids: string[] = [];
  try {
    // Check every part before accepting any. When at least one part is accepted, the parts that
    // were refused are recorded as FAILED, so they show in the console, and the client gets 250.
    const accepted: PreparedSend[] = [];
    const refused: Array<{ payload: SendEmailInput; statusCode: number; error: string; message: string }> = [];
    for (const payload of payloads) {
      const checked = await prepareSend(user.organizationId, payload, { testMode: user.testMode });
      if (checked.ok) accepted.push(checked.prepared);
      else refused.push({ payload, statusCode: checked.statusCode, error: checked.error, message: checked.message });
    }
    if (accepted.length === 0) {
      const first = refused[0];
      throw smtpReplyFor(first.statusCode, first.error, first.message);
    }

    // The plan's quota for all accepted parts at once: if it cannot take them, nothing is accepted
    const charge = accepted.reduce((total, part) => total + part.chargeable, 0);
    const usage = charge > 0 ? await reserveUsage(user.organizationId, charge) : null;
    if (usage && !usage.ok) throw smtpReplyFor(usage.statusCode, usage.error, usage.message);

    for (const prepared of accepted) {
      try {
        const result = await commitSend(prepared);
        ids.push(result.email.id);
        await announceSmtp(user.organizationId, result).catch(() => undefined);
      } catch (err) {
        // Not saved: give back its quota. The other parts are still accepted.
        if (usage?.ok && prepared.chargeable > 0) await releaseUsage(user.organizationId, prepared.chargeable, usage.day);
        console.error("[smtp] a part of a split message could not be saved", err);
      }
    }
    if (ids.length === 0) throw smtpError(451, "4.3.0 Temporary failure, try again");

    for (const part of refused) {
      await recordRefusedEmail(user.organizationId, part.payload, { error: part.error, message: part.message }, { testMode: user.testMode }).catch(
        (err) => console.error("[smtp] could not record a refused part", err),
      );
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
  await Promise.allSettled([prisma.$disconnect(), redisRequests.quit()]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
