import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";
import { EMAIL_MAX_ATTEMPTS } from "../delivery/attempts.js";

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
/** TredMail's own account, billing and alert mail: never waits behind customer mail. */
export const SYSTEM_EMAIL_QUEUE_NAME = "tredmail-system-delivery";

/** Retry policy name; the worker's backoffStrategy implements it (core/delivery/attempts.ts). */
export const EMAIL_BACKOFF_TYPE = "delivery";

const queueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: EMAIL_MAX_ATTEMPTS,
    backoff: { type: EMAIL_BACKOFF_TYPE },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
};

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, queueOptions);
export const systemEmailQueue = new Queue<EmailJobData>(SYSTEM_EMAIL_QUEUE_NAME, queueOptions);

export type EmailPriorityName = "NORMAL" | "SYSTEM";

const queueFor = (priority: EmailPriorityName = "NORMAL") => (priority === "SYSTEM" ? systemEmailQueue : emailQueue);

/**
 * Queues an email for delivery, now or at `sendAt`. The job id is the email id, so queueing
 * the same email again is a no-op while its job exists.
 */
export async function enqueueEmail(data: EmailJobData, sendAt?: Date | null, priority: EmailPriorityName = "NORMAL") {
  const delay = sendAt ? Math.max(0, sendAt.getTime() - Date.now()) : 0;
  return await queueFor(priority).add(`deliver:${data.emailId}`, data, { jobId: data.emailId, delay });
}

/** Removes an email's waiting or delayed job (when it is canceled or rescheduled). */
export async function removeQueuedEmail(emailId: string) {
  for (const queue of [emailQueue, systemEmailQueue]) {
    const job = await queue.getJob(emailId);
    if (job && !(await job.isActive())) await job.remove();
  }
}
