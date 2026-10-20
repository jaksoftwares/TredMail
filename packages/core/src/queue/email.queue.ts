import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";

export interface EmailJobData {
  emailId: string;
  organizationId: string;
  domainId: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    content: string; // base64
    contentType?: string;
  }>;
  trackOpens?: boolean;
  trackClicks?: boolean;
  /** Value of the "category" tag, used in the Feedback-ID header for Gmail's complaint reports. */
  category?: string;
}

export const EMAIL_QUEUE_NAME = "tredmail-email-delivery";

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 5000, // 5s, 10s, 20s, 40s...
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

/**
 * Enqueues an email job for background compilation, DKIM signing, and delivery.
 */
export async function enqueueEmail(data: EmailJobData) {
  return await emailQueue.add(`deliver:${data.emailId}`, data, {
    jobId: data.emailId,
  });
}
