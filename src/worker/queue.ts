import { Worker, Job } from "bullmq";
import nodemailer from "nodemailer";
import { redisConnection } from "../queue/redis.js";
import { EMAIL_QUEUE_NAME, EmailJobData } from "../queue/email.queue.js";
import { prisma } from "../db/client.js";
import { decryptSecret } from "../security/crypto.js";
import { prepareEmailBody } from "./mime.js";
import { env } from "../config/env.js";

console.log("👷 Starting TredMail Email Delivery Worker...");

export const emailWorker = new Worker<EmailJobData>(
  EMAIL_QUEUE_NAME,
  async (job: Job<EmailJobData>) => {
    const data = job.data;
    console.log(`\n📨 Processing delivery job for email ID: ${data.emailId}`);

    // 1. Fetch domain & decrypt DKIM private key
    const domain = await prisma.domain.findUnique({
      where: { id: data.domainId },
    });

    if (!domain) {
      throw new Error(`Domain not found for ID: ${data.domainId}`);
    }

    let dkimPrivateKey: string | undefined;
    try {
      dkimPrivateKey = decryptSecret(domain.dkimPrivateKey);
    } catch (err: any) {
      console.warn(`⚠️ Could not decrypt DKIM key for domain ${domain.name}:`, err.message);
    }

    // 2. Prepare HTML & tracking injection
    const prepared = prepareEmailBody(data.emailId, data.html, data.text, {
      trackOpens: data.trackOpens,
      trackClicks: data.trackClicks,
    });

    // 3. Configure Nodemailer Transporter with DKIM signing
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ignoreTLS: env.NODE_ENV === "development" && !env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      tls: {
        rejectUnauthorized: false, // Allows self-signed certificates in dev/local setups
      },
      // Cryptographic DKIM Signature
      dkim: dkimPrivateKey
        ? {
            domainName: domain.name,
            keySelector: domain.dkimSelector,
            privateKey: dkimPrivateKey,
            cacheDir: false,
          }
        : undefined,
    });

    // 4. Construct RFC-compliant headers
    const messageId = `<${data.emailId}@mail.${domain.name}>`;
    const mailOptions: nodemailer.SendMailOptions = {
      from: data.from,
      to: data.to,
      cc: data.cc,
      bcc: data.bcc,
      replyTo: data.replyTo,
      subject: data.subject,
      html: prepared.html,
      text: prepared.text,
      messageId: messageId,
      headers: {
        ...data.headers,
        "X-TredMail-ID": data.emailId,
        "X-TredMail-Domain": domain.name,
        // One-Click Unsubscribe Mandate (RFC 8058)
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "List-Unsubscribe": `<${env.API_BASE_URL}/unsubscribe/${data.emailId}>`,
      },
      attachments: data.attachments?.map((att) => ({
        filename: att.filename,
        content: Buffer.from(att.content, "base64"),
        contentType: att.contentType,
      })),
    };

    // 5. Send message over SMTP
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ SMTP Handshake Successful! Message ID: ${info.messageId}`);
    console.log(`   Response: ${info.response}`);

    // 6. Update database record to DELIVERED
    await prisma.email.update({
      where: { id: data.emailId },
      data: {
        status: "DELIVERED",
        messageId: info.messageId,
        smtpResponse: info.response,
        deliveredAt: new Date(),
      },
    });

    // 7. Log DELIVERED event
    await prisma.emailEvent.create({
      data: {
        emailId: data.emailId,
        type: "DELIVERED",
        details: {
          smtpResponse: info.response,
          accepted: info.accepted,
          rejected: info.rejected,
        },
      },
    });

    return { success: true, messageId: info.messageId, response: info.response };
  },
  {
    connection: redisConnection,
    concurrency: 10, // Process 10 concurrent email deliveries
  }
);

emailWorker.on("completed", (job) => {
  console.log(`🎉 Job ${job.id} completed successfully.`);
});

emailWorker.on("failed", async (job, err) => {
  console.error(`❌ Job ${job?.id} failed with error:`, err.message);

  if (job?.data?.emailId) {
    await prisma.email.update({
      where: { id: job.data.emailId },
      data: {
        status: "FAILED",
        smtpResponse: err.message,
      },
    });

    await prisma.emailEvent.create({
      data: {
        emailId: job.data.emailId,
        type: "BOUNCED",
        bounceType: "SOFT",
        details: {
          error: err.message,
          stack: err.stack,
        },
      },
    });
  }
});
