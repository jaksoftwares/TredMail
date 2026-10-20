import { DelayedError, Worker, Job, UnrecoverableError } from "bullmq";
import nodemailer from "nodemailer";
import { redisConnection } from "@tredmail/core/queue/redis";
import { EMAIL_QUEUE_NAME, EmailJobData } from "@tredmail/core/queue/email.queue";
import { prisma } from "@tredmail/db";
import { decryptSecret } from "@tredmail/core/security/crypto";
import { createTrackingSigner } from "@tredmail/core/security/tracking-signature";
import { prepareEmailBody } from "@tredmail/core/mail/mime";
import { env } from "@tredmail/core/config/env";
import { dispatchWebhookEvent } from "@tredmail/core/webhooks/dispatcher";
import { createVerpCodec, returnPathDomainFor } from "@tredmail/core/mail/verp";
import { msUntilNextUtcDay, reserveWarmupSlots, warmupCap } from "@tredmail/core/delivery/warmup";
import { isStagingAllowlisted, parseAllowlist } from "@tredmail/core/delivery/staging-allowlist";
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
 */
async function chooseRoute(recipients: string[]): Promise<Route | null> {
  if (stagingTransporter && recipients.every((r) => isStagingAllowlisted(r, stagingAllowlist))) return "staging";
  const cap = warmupCap(env.MTA_WARMUP_START);
  if (await reserveWarmupSlots(redisConnection, cap, recipients.length)) return "mta";
  return fallbackTransporter ? "fallback" : null;
}

const transporterFor = (route: Route) =>
  route === "mta" ? transporter : route === "staging" ? stagingTransporter! : fallbackTransporter!;

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

const SENDABLE = new Set(["QUEUED", "SCHEDULED", "SENDING"]);

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

  const domain = email.domain;
  if (domain.status !== "VERIFIED") {
    throw new UnrecoverableError(`Domain ${domain.name} is no longer verified.`);
  }

  // Never send unsigned mail: it would fail DMARC and damage the domain's reputation.
  let dkimPrivateKey: string;
  try {
    dkimPrivateKey = decryptSecret(domain.dkimPrivateKey);
  } catch (err) {
    throw new UnrecoverableError(`Cannot decrypt DKIM key for ${domain.name}: ${describe(err)}`);
  }

  const recipients = [...email.to, ...email.cc, ...email.bcc];
  const route = await chooseRoute(recipients);
  if (!route) {
    // Warm-up cap reached and no fallback relay: hold the message until tomorrow's allowance.
    const delay = msUntilNextUtcDay() + Math.floor(Math.random() * 15 * 60_000);
    await prisma.emailEvent.create({
      data: { emailId, type: "DEFERRED", details: { reason: "warmup_cap_reached", retryAt: new Date(Date.now() + delay).toISOString() } },
    });
    await job.moveToDelayed(Date.now() + delay, token);
    throw new DelayedError();
  }

  await prisma.email.update({ where: { id: emailId }, data: { status: "SENDING" } });

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

  const info = await transporterFor(route).sendMail({
    envelope,
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    replyTo: email.replyTo ?? undefined,
    subject: email.subject,
    html: prepared.html,
    text: prepared.text,
    messageId: `<${emailId}@${domain.name}>`,
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
  });

  // Accepted by the mail server. DELIVERED comes later from KumoMTA's delivery log; mail sent
  // through the fallback relay stays SENT (that provider's events are not collected).
  const sentAt = new Date();
  await prisma.$transaction([
    prisma.email.update({
      where: { id: emailId },
      data: { status: "SENT", messageId: info.messageId, smtpResponse: info.response },
    }),
    prisma.emailEvent.create({
      data: {
        emailId,
        type: "SENT",
        details: {
          route,
          smtpResponse: info.response,
          accepted: info.accepted.map(String),
          rejected: info.rejected.map(String),
        },
      },
    }),
  ]);

  await dispatchWebhookEvent(email.organizationId, "email.sent", {
    email_id: emailId,
    to: email.to,
    from: email.from,
    subject: email.subject,
    smtp_response: info.response,
    sent_at: sentAt.toISOString(),
  }).catch((err) => console.error("webhook dispatch failed", err));

  return { messageId: info.messageId, response: info.response };
}

export const emailWorker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, deliver, {
  connection: redisConnection,
  concurrency: 10,
});

const monitor = startMonitor();
const webhookWorker = startWebhookWorker();

emailWorker.on("completed", (job) => {
  console.log(`[worker] sent ${job.id}`);
});

// BullMQ emits "failed" on every failed attempt, including ones that will be retried.
emailWorker.on("failed", async (job, err) => {
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
});

const shutdown = async () => {
  await Promise.allSettled([emailWorker.close(), monitor.close(), webhookWorker.close()]);
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
