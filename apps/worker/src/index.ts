import { Worker, Job, UnrecoverableError } from "bullmq";
import nodemailer from "nodemailer";
import { redisConnection } from "@tredmail/core/queue/redis";
import { EMAIL_QUEUE_NAME, EmailJobData } from "@tredmail/core/queue/email.queue";
import { prisma } from "@tredmail/db";
import { decryptSecret } from "@tredmail/core/security/crypto";
import { createTrackingSigner } from "@tredmail/core/security/tracking-signature";
import { prepareEmailBody } from "@tredmail/core/mail/mime";
import { env } from "@tredmail/core/config/env";
import { dispatchWebhookEvent } from "@tredmail/core/webhooks/dispatcher";

const signer = createTrackingSigner(env.TREDMAIL_MASTER_ENCRYPTION_KEY);

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

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function deliver(job: Job<EmailJobData>) {
  const data = job.data;

  const domain = await prisma.domain.findUnique({ where: { id: data.domainId } });
  if (!domain) {
    throw new UnrecoverableError(`Domain ${data.domainId} no longer exists.`);
  }
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

  await prisma.email.update({ where: { id: data.emailId }, data: { status: "SENDING" } });

  const prepared = prepareEmailBody(data.emailId, data.html, data.text, {
    trackOpens: data.trackOpens,
    trackClicks: data.trackClicks,
    trackingBaseUrl: env.TRACKING_BASE_URL,
    signer,
  });

  const info = await transporter.sendMail({
    from: data.from,
    to: data.to,
    cc: data.cc,
    bcc: data.bcc,
    replyTo: data.replyTo,
    subject: data.subject,
    html: prepared.html,
    text: prepared.text,
    messageId: `<${data.emailId}@${domain.name}>`,
    headers: {
      ...data.headers,
      "X-TredMail-ID": data.emailId,
    },
    attachments: data.attachments?.map((att) => ({
      filename: att.filename,
      content: Buffer.from(att.content, "base64"),
      contentType: att.contentType,
    })),
    dkim: {
      domainName: domain.name,
      keySelector: domain.dkimSelector,
      privateKey: dkimPrivateKey,
    },
  });

  // Accepted by the relay/MTA. DELIVERED is set only from MTA delivery logs (roadmap Phase 2).
  const sentAt = new Date();
  await prisma.$transaction([
    prisma.email.update({
      where: { id: data.emailId },
      data: { status: "SENT", messageId: info.messageId, smtpResponse: info.response },
    }),
    prisma.emailEvent.create({
      data: {
        emailId: data.emailId,
        type: "SENT",
        details: {
          smtpResponse: info.response,
          accepted: info.accepted.map(String),
          rejected: info.rejected.map(String),
        },
      },
    }),
  ]);

  dispatchWebhookEvent(data.organizationId, "email.sent", {
    email_id: data.emailId,
    to: data.to,
    from: data.from,
    subject: data.subject,
    smtp_response: info.response,
    sent_at: sentAt.toISOString(),
  }).catch((err) => console.error("webhook dispatch failed", err));

  return { messageId: info.messageId, response: info.response };
}

export const emailWorker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, deliver, {
  connection: redisConnection,
  concurrency: 10,
});

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

    await prisma.$transaction([
      prisma.email.update({ where: { id: job.data.emailId }, data: { status: "FAILED", smtpResponse: reason } }),
      prisma.emailEvent.create({
        data: { emailId: job.data.emailId, type: "FAILED", details: { attempts: job.attemptsMade, error: reason } },
      }),
    ]);
    console.error(`[worker] ${job.id} failed permanently: ${reason}`);

    await dispatchWebhookEvent(job.data.organizationId, "email.failed", {
      email_id: job.data.emailId,
      to: job.data.to,
      from: job.data.from,
      subject: job.data.subject,
      error: reason,
    });
  } catch (recordErr) {
    console.error(`[worker] could not record failure for ${job.id}`, recordErr);
  }
});

const shutdown = async () => {
  await emailWorker.close();
  transporter.close();
  await Promise.allSettled([prisma.$disconnect(), redisConnection.quit()]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

console.log(`[worker] TredMail delivery worker started (SMTP ${env.SMTP_HOST}:${env.SMTP_PORT})`);
