import { DelayedError, Worker, Job, UnrecoverableError } from "bullmq";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { redisConnection } from "@tredmail/core/queue/redis";
import { EMAIL_QUEUE_NAME, SYSTEM_EMAIL_QUEUE_NAME, type EmailJobData } from "@tredmail/core/queue/email.queue";
import { prisma } from "@tredmail/db";
import { decryptSecret } from "@tredmail/core/security/crypto";
import { createTrackingSigner } from "@tredmail/core/security/tracking-signature";
import { prepareEmailBody } from "@tredmail/core/mail/mime";
import { env } from "@tredmail/core/config/env";
import { dispatchWebhookEvent } from "@tredmail/core/webhooks/dispatcher";
import { createVerpCodec, returnPathDomainFor } from "@tredmail/core/mail/verp";
import { msUntilNextUtcDay, reserveWarmupSlots, warmupCap } from "@tredmail/core/delivery/warmup";
import { isStagingAllowlisted, parseAllowlist } from "@tredmail/core/delivery/staging-allowlist";
import {
  DOMAIN_RECHECK_MS,
  classifySendError,
  describeSendError,
  domainHoldDecision,
  emailRetryDelay,
  recoveryDecision,
  type SendErrorLike,
} from "@tredmail/core/delivery/attempts";
import { startMonitor } from "./monitor.js";
import { startWebhookWorker } from "./webhooks.js";

const signer = createTrackingSigner(env.TREDMAIL_MASTER_ENCRYPTION_KEY);
const verp = createVerpCodec(env.TREDMAIL_MASTER_ENCRYPTION_KEY);

// One pooled connection set per worker process; DKIM is applied per message.
const transporter = nodemailer.createTransport({
  pool: true,
  maxConnections: 5,
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  ignoreTLS: env.NODE_ENV === "development" && !env.SMTP_SECURE,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  tls: { rejectUnauthorized: !env.SMTP_ALLOW_INVALID_CERTS },
});

// Optional relay through another provider for mail above the day's IP warm-up cap.
const fallbackTransporter = env.FALLBACK_SMTP_HOST
  ? nodemailer.createTransport({
      pool: true,
      maxConnections: 2,
      host: env.FALLBACK_SMTP_HOST,
      port: env.FALLBACK_SMTP_PORT,
      secure: env.FALLBACK_SMTP_SECURE,
      auth: env.FALLBACK_SMTP_USER ? { user: env.FALLBACK_SMTP_USER, pass: env.FALLBACK_SMTP_PASS } : undefined,
    })
  : null;

// Staging only: messages whose recipients are all on the allowlist go to a real mail server
// instead of Mailpit, so the team can check real inboxes without risking anyone else.
const stagingAllowlist = parseAllowlist(env.STAGING_DELIVERY_ALLOWLIST);
const stagingTransporter =
  env.STAGING_DELIVERY_SMTP_HOST && stagingAllowlist.length > 0
    ? nodemailer.createTransport({
        pool: true,
        maxConnections: 2,
        host: env.STAGING_DELIVERY_SMTP_HOST,
        port: env.STAGING_DELIVERY_SMTP_PORT,
        secure: false,
        ignoreTLS: true, // KumoMTA's internal injection port
      })
    : null;

type Route = "mta" | "fallback" | "staging";

/**
 * Picks the route for a message: our own mail server while today's warm-up allowance lasts,
 * then the fallback relay. Returns null when the cap is reached and there is no fallback.
 * TredMail's own (SYSTEM) mail is low volume and always uses our mail server, outside the cap.
 */
async function chooseRoute(recipients: string[], priority: string): Promise<Route | null> {
  if (stagingTransporter && recipients.every((r) => isStagingAllowlisted(r, stagingAllowlist))) return "staging";
  if (priority === "SYSTEM") return "mta";
  const cap = warmupCap(env.MTA_WARMUP_START);
  if (await reserveWarmupSlots(redisConnection, cap, recipients.length)) return "mta";
  return fallbackTransporter ? "fallback" : null;
}

const transporterFor = (route: Route) =>
  route === "mta" ? transporter : route === "staging" ? stagingTransporter! : fallbackTransporter!;

const describe = describeSendError;

const SENDABLE = new Set(["QUEUED", "SCHEDULED", "SENDING"]);

/** Retries a database write a few times: it follows a hand-off that must not be repeated. */
async function persist<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

interface SentResult {
  route: string;
  messageId: string;
  response: string;
  accepted: string[];
  rejected: string[];
}

/** Records the mail server's acceptance (SENT) and announces it. */
async function markSent(email: { id: string; organizationId: string; to: string[]; from: string; subject: string }, result: SentResult) {
  const sentAt = new Date();
  await persist(() =>
    prisma.$transaction([
      prisma.email.update({
        where: { id: email.id },
        data: { status: "SENT", messageId: result.messageId, smtpResponse: result.response, sendAttemptAt: null },
      }),
      prisma.emailEvent.create({
        data: {
          emailId: email.id,
          type: "SENT",
          details: { route: result.route, smtpResponse: result.response, accepted: result.accepted, rejected: result.rejected },
        },
      }),
    ]),
  );
  await dispatchWebhookEvent(email.organizationId, "email.sent", {
    email_id: email.id,
    to: email.to,
    from: email.from,
    subject: email.subject,
    smtp_response: result.response,
    sent_at: sentAt.toISOString(),
  }).catch((err) => console.error("webhook dispatch failed", err));
}

/** Holds a job until `at`, recording why once per reason (the dedupe key keeps it to one event). */
async function hold(job: Job<EmailJobData>, token: string | undefined, at: number, reason: string): Promise<never> {
  await prisma.emailEvent
    .create({
      data: {
        emailId: job.data.emailId,
        type: "DEFERRED",
        dedupeKey: `hold:${reason}`,
        details: { reason, retryAt: new Date(at).toISOString() },
      },
    })
    .catch((err) => {
      if ((err as { code?: string }).code !== "P2002") throw err;
    });
  await job.moveToDelayed(at, token);
  throw new DelayedError();
}

function categoryOf(tags: unknown): string {
  const list = Array.isArray(tags) ? (tags as Array<{ name?: unknown; value?: unknown }>) : [];
  const value = list.find((t) => t?.name === "category")?.value;
  return (typeof value === "string" && value ? value : "transactional").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "transactional";
}

async function deliver(job: Job<EmailJobData>, token?: string) {
  const { emailId } = job.data;

  const email = await prisma.email.findUnique({ where: { id: emailId }, include: { attachments: true, domain: true } });
  if (!email) throw new UnrecoverableError(`Email ${emailId} no longer exists.`);
  // Canceled, already sent, or finished by an earlier attempt: nothing to do.
  if (!SENDABLE.has(email.status)) return { skipped: email.status };

  // Rescheduled to a later time after this job was created
  if (email.status === "SCHEDULED" && email.scheduledAt && email.scheduledAt.getTime() > Date.now() + 1000) {
    await job.moveToDelayed(email.scheduledAt.getTime(), token);
    throw new DelayedError();
  }

  const recipients = [...email.to, ...email.cc, ...email.bcc];
  const messageId = `<${emailId}@${email.domain.name}>`;

  // A previous attempt may have reached the mail server before the process died or the SENT
  // write failed. KumoMTA reports each reception, so check before sending a second copy.
  const recovery = recoveryDecision(email);
  if (recovery.action === "already_sent") {
    await markSent(email, {
      route: email.sendRoute ?? "mta",
      messageId,
      response: "Accepted by the mail server (recorded after an interrupted attempt)",
      accepted: recipients,
      rejected: [],
    });
    return { recovered: true };
  }
  if (recovery.action === "wait") {
    await job.moveToDelayed(recovery.until.getTime(), token);
    throw new DelayedError();
  }

  // A domain that is not verified right now is usually a DNS problem being fixed: hold the
  // mail and check again, and fail it only after a long wait.
  const domain = email.domain;
  const domainDecision = domainHoldDecision(domain.status, email.scheduledAt ?? email.createdAt);
  if (domainDecision === "fail") {
    throw new UnrecoverableError(`Domain ${domain.name} has not been verified for 72 hours, so this email was not sent.`);
  }
  if (domainDecision === "hold") {
    await hold(job, token, Date.now() + DOMAIN_RECHECK_MS, "domain_not_verified");
  }

  // Never send unsigned mail: it would fail DMARC and damage the domain's reputation.
  let dkimPrivateKey: string;
  try {
    dkimPrivateKey = decryptSecret(domain.dkimPrivateKey);
  } catch (err) {
    throw new UnrecoverableError(`Cannot decrypt DKIM key for ${domain.name}: ${describe(err)}`);
  }

  const route = await chooseRoute(recipients, email.priority);
  if (!route) {
    // Warm-up cap reached and no fallback relay: hold the message until tomorrow's allowance.
    const day = new Date().toISOString().slice(0, 10);
    return hold(job, token, Date.now() + msUntilNextUtcDay() + Math.floor(Math.random() * 15 * 60_000), `warmup_cap_reached:${day}`);
  }

  // The attempt marker: from here until SENT is written, a retry checks before resending.
  await prisma.email.update({
    where: { id: emailId },
    data: { status: "SENDING", sendAttemptAt: new Date(), sendRoute: route, mtaAcceptedAt: null },
  });

  const prepared = prepareEmailBody(emailId, email.htmlBody ?? undefined, email.textBody ?? undefined, {
    trackOpens: email.trackOpens,
    trackClicks: email.trackClicks,
    trackingBaseUrl: env.TRACKING_BASE_URL,
    signer,
  });

  // KumoMTA (production or staging) gets a VERP envelope so bounces map back to this email.
  // Other providers set their own return path.
  const envelope =
    route === "fallback" ? undefined : { from: verp.encode(emailId, returnPathDomainFor(domain, env.BOUNCE_DOMAIN)), to: recipients };

  const customHeaders = ((email.metadata as { headers?: Record<string, string> } | null)?.headers ?? {}) as Record<string, string>;
  const attachments =
    email.attachments.length > 0
      ? email.attachments.map((att) => ({
          filename: att.filename,
          content: Buffer.from(att.content),
          contentType: att.contentType ?? undefined,
          cid: att.contentId ?? undefined,
        }))
      : job.data.attachments?.map((att) => ({ filename: att.filename, content: Buffer.from(att.content, "base64"), contentType: att.contentType }));

  const message: SendMailOptions = {
    envelope,
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    replyTo: email.replyTo ?? undefined,
    subject: email.subject,
    html: prepared.html,
    text: prepared.text,
    messageId,
    headers: {
      ...customHeaders,
      "X-TredMail-ID": emailId,
      // Gmail's feedback loop reports complaint rates per value: category, workspace, sender
      "Feedback-ID": `${categoryOf(email.tags)}:${email.organizationId}:tredmail`,
    },
    attachments,
    dkim: {
      domainName: domain.name,
      keySelector: domain.dkimSelector,
      privateKey: dkimPrivateKey,
    },
  };

  let info: SMTPTransport.SentMessageInfo;
  try {
    info = await transporterFor(route).sendMail(message);
  } catch (err) {
    const kind = classifySendError(err as SendErrorLike);
    // A definite failure means the server does not have the message: clear the marker so the
    // retry sends at once. When unsure, keep it so the retry checks for a reception first.
    if (kind !== "unknown") {
      await prisma.email.update({ where: { id: emailId }, data: { sendAttemptAt: null } }).catch(() => undefined);
    }
    if (kind === "permanent") throw new UnrecoverableError(`The mail server refused this email: ${describe(err)}`);
    throw err;
  }

  // Accepted by the mail server. DELIVERED comes later from KumoMTA's delivery log; mail sent
  // through the fallback relay stays SENT (that provider's events are not collected).
  await markSent(email, {
    route,
    messageId: info.messageId,
    response: info.response,
    accepted: info.accepted.map(String),
    rejected: info.rejected.map(String),
  });
  return { messageId: info.messageId, response: info.response };
}

// Retry timing for failed hand-offs (core/delivery/attempts.ts): about 6 hours in total.
const workerSettings = { backoffStrategy: (attemptsMade: number) => emailRetryDelay(attemptsMade) };

export const emailWorker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, deliver, {
  connection: redisConnection,
  concurrency: 10,
  settings: workerSettings,
});

// TredMail's own account, billing and alert mail, on its own queue so it never waits behind
// a backlog of customer mail.
export const systemEmailWorker = new Worker<EmailJobData>(SYSTEM_EMAIL_QUEUE_NAME, deliver, {
  connection: redisConnection,
  concurrency: 5,
  settings: workerSettings,
});

const monitor = startMonitor();
const webhookWorker = startWebhookWorker();

// BullMQ emits "failed" on every failed attempt, including ones that will be retried.
async function onFailed(job: Job<EmailJobData> | undefined, err: Error) {
  if (!job?.data?.emailId) return;

  const maxAttempts = job.opts.attempts ?? 1;
  const isFinal = err instanceof UnrecoverableError || job.attemptsMade >= maxAttempts;
  const reason = describe(err);

  try {
    if (!isFinal) {
      await prisma.emailEvent.create({
        data: {
          emailId: job.data.emailId,
          type: "DEFERRED",
          details: { attempt: job.attemptsMade, maxAttempts, error: reason },
        },
      });
      console.warn(`[worker] ${job.id} attempt ${job.attemptsMade}/${maxAttempts} failed: ${reason}`);
      return;
    }

    const email = await prisma.email.update({ where: { id: job.data.emailId }, data: { status: "FAILED", smtpResponse: reason } });
    await prisma.emailEvent.create({
      data: { emailId: job.data.emailId, type: "FAILED", details: { attempts: job.attemptsMade, error: reason } },
    });
    console.error(`[worker] ${job.id} failed permanently: ${reason}`);

    await dispatchWebhookEvent(email.organizationId, "email.failed", {
      email_id: email.id,
      to: email.to,
      from: email.from,
      subject: email.subject,
      error: reason,
    });
  } catch (recordErr) {
    console.error(`[worker] could not record failure for ${job.id}`, recordErr);
  }
}

for (const worker of [emailWorker, systemEmailWorker]) {
  worker.on("completed", (job) => console.log(`[worker] sent ${job.id}`));
  worker.on("failed", (job, err) => void onFailed(job, err));
}

const shutdown = async () => {
  await Promise.allSettled([emailWorker.close(), systemEmailWorker.close(), monitor.close(), webhookWorker.close()]);
  transporter.close();
  fallbackTransporter?.close();
  stagingTransporter?.close();
  await Promise.allSettled([prisma.$disconnect(), redisConnection.quit()]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

const cap = warmupCap(env.MTA_WARMUP_START);
console.log(
  `[worker] TredMail delivery worker started (SMTP ${env.SMTP_HOST}:${env.SMTP_PORT}; ` +
    `warm-up ${cap === null ? "off" : `cap ${cap}/day`}; fallback ${fallbackTransporter ? env.FALLBACK_SMTP_HOST : "none"}` +
    `${stagingTransporter ? `; staging delivery to ${stagingAllowlist.length} allowlisted entries` : ""})`,
);
