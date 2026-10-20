import { Worker, type Job } from "bullmq";
import { prisma } from "@tredmail/db";
import { redisConnection } from "@tredmail/core/queue/redis";
import {
  WEBHOOK_QUEUE_NAME,
  WEBHOOK_RETRY_DELAYS_MS,
  attemptWebhook,
  type WebhookJobData,
  type WebhookPayload,
} from "@tredmail/core/webhooks/dispatcher";

class WebhookAttemptFailed extends Error {}

/** Delivers webhook events with retries (WEBHOOK_RETRY_DELAYS_MS) and records each attempt. */
export function startWebhookWorker() {
  const worker = new Worker<WebhookJobData>(
    WEBHOOK_QUEUE_NAME,
    async (job: Job<WebhookJobData>) => {
      const delivery = await prisma.webhookDelivery.findUnique({ where: { id: job.data.deliveryId }, include: { webhook: true } });
      if (!delivery || delivery.status === "succeeded") return "skipped";
      if (!delivery.webhook.isActive) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: "failed", nextAttemptAt: null, response: "Endpoint disabled before delivery" },
        });
        return "endpoint_disabled";
      }

      const result = await attemptWebhook(delivery.webhook, delivery.messageId ?? delivery.id, delivery.payload as unknown as WebhookPayload);
      const attemptNumber = job.attemptsMade + 1;
      const maxAttempts = job.opts.attempts ?? 1;
      const willRetry = !result.success && attemptNumber < maxAttempts;
      const retryDelay = WEBHOOK_RETRY_DELAYS_MS[Math.min(attemptNumber - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)];

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts: { increment: 1 },
          statusCode: result.statusCode,
          response: result.response,
          success: result.success,
          lastAttemptAt: new Date(),
          status: result.success ? "succeeded" : willRetry ? "pending" : "failed",
          nextAttemptAt: willRetry ? new Date(Date.now() + retryDelay) : null,
        },
      });
      if (!result.success) {
        throw new WebhookAttemptFailed(`HTTP ${result.statusCode || "error"}: ${result.response.slice(0, 200)}`);
      }
      return "delivered";
    },
    {
      connection: redisConnection,
      concurrency: 20,
      settings: {
        backoffStrategy: (attemptsMade: number) =>
          WEBHOOK_RETRY_DELAYS_MS[Math.min(attemptsMade - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)],
      },
    },
  );
  worker.on("failed", (job, err) => {
    if (!(err instanceof WebhookAttemptFailed)) console.error(`[webhooks] delivery ${job?.data.deliveryId} errored`, err);
  });
  return worker;
}
