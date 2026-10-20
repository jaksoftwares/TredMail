import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";

/**
 * Jobs carry only identifiers: the worker reads the message from the database, so content
 * never sits in Redis and a lost job can be rebuilt from the row (see the outbox sweeper).
 */
export interface EmailJobData {
  emailId: string;
  organizationId: string;
  domainId: string;
  /** Jobs queued before Phase 3 carried attachments here instead of in the database. */
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
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
 * Queues an email for delivery, now or at `sendAt`. The job id is the email id, so queueing
 * the same email again is a no-op while its job exists.
 */
export async function enqueueEmail(data: EmailJobData, sendAt?: Date | null) {
  const delay = sendAt ? Math.max(0, sendAt.getTime() - Date.now()) : 0;
  return await emailQueue.add(`deliver:${data.emailId}`, data, { jobId: data.emailId, delay });
}

/** Removes an email's waiting or delayed job (when it is canceled or rescheduled). */
export async function removeQueuedEmail(emailId: string) {
  const job = await emailQueue.getJob(emailId);
  if (job && !(await job.isActive())) await job.remove();
}
