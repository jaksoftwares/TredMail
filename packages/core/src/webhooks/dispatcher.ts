import crypto from "crypto";
import { Queue } from "bullmq";
import type { Prisma, Webhook } from "@tredmail/db";
import { prisma } from "@tredmail/db";
import { env } from "../config/env.js";
import { redisConnection } from "../queue/redis.js";
import { assertPublicHttpUrl } from "../security/url-safety.js";

import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "./events.js";

export { WEBHOOK_EVENT_TYPES, type WebhookEventType };

export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString("base64")}`;
}

/**
 * Standard Webhooks signature (https://www.standardwebhooks.com): HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` keyed with the base64 part of the secret. Binding the
 * timestamp lets receivers reject replays.
 */
export function signWebhookPayload(secret: string, messageId: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const digest = crypto.createHmac("sha256", key).update(`${messageId}.${timestamp}.${body}`).digest("base64");
  return `v1,${digest}`;
}

const allowPrivateTargets = () => env.NODE_ENV !== "production" && env.WEBHOOK_ALLOW_PRIVATE_TARGETS;

export async function assertWebhookUrlAllowed(url: string) {
  await assertPublicHttpUrl(url, { allowPrivate: allowPrivateTargets() });
}

export interface WebhookPayload {
  type: string;
  created_at: string;
  data: Record<string, unknown>;
}

/**
 * Makes one HTTP attempt. Never throws. The signature timestamp is the time of this
 * attempt (receivers reject stale timestamps); the message id stays the same on every
 * retry and replay so receivers can drop duplicates.
 */
export async function attemptWebhook(webhook: Pick<Webhook, "url" | "secret">, messageId: string, payload: WebhookPayload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  let statusCode = 0;
  let response: string;
  let success = false;

  try {
    await assertWebhookUrlAllowed(webhook.url);
    const res = await fetch(webhook.url, {
      method: "POST",
      redirect: "manual", // a redirect could point at an internal address
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "TredMail-Webhook/1.0",
        "webhook-id": messageId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhookPayload(webhook.secret, messageId, timestamp, body),
        "X-TredMail-Event": payload.type,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = res.status;
    response = (await res.text().catch(() => "")).substring(0, 1000);
    success = res.ok;
  } catch (err) {
    response = err instanceof Error ? err.message : String(err);
  }
  return { success, statusCode, response };
}

const newMessageId = () => `msg_${crypto.randomUUID().replace(/-/g, "")}`;
const makePayload = (event: string, data: Record<string, unknown>): WebhookPayload => ({ type: event, created_at: new Date().toISOString(), data });

/** Delivers one event right away with a single attempt and records it (the "send test" button). */
export async function deliverWebhook(webhook: Webhook, event: WebhookEventType, data: Record<string, unknown>) {
  const messageId = newMessageId();
  const payload = makePayload(event, data);
  const result = await attemptWebhook(webhook, messageId, payload);
  await prisma.webhookDelivery
    .create({
      data: {
        webhookId: webhook.id,
        event,
        messageId,
        payload: payload as unknown as Prisma.InputJsonObject,
        status: result.success ? "succeeded" : "failed",
        statusCode: result.statusCode,
        response: result.response,
        attempts: 1,
        success: result.success,
        lastAttemptAt: new Date(),
      },
    })
    .catch((err) => console.error("failed to record webhook delivery", err));
  return { success: result.success, statusCode: result.statusCode };
}

// ---------------------------------------------------------------------------
// Queued delivery with retries
// ---------------------------------------------------------------------------

export const WEBHOOK_QUEUE_NAME = "tredmail-webhooks";

/** Delay before each retry: about 27 hours of retries over 10 attempts in total. */
export const WEBHOOK_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000, 43_200_000];

export interface WebhookJobData {
  deliveryId: string;
}

let webhookQueue: Queue<WebhookJobData> | null = null;
export function getWebhookQueue() {
  webhookQueue ??= new Queue<WebhookJobData>(WEBHOOK_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: WEBHOOK_RETRY_DELAYS_MS.length + 1,
      backoff: { type: "webhook" },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  return webhookQueue;
}

/** Queues delivery of an existing delivery record (first send, or a replay). */
export async function queueWebhookDelivery(deliveryId: string, jobId = deliveryId) {
  await getWebhookQueue().add("deliver", { deliveryId }, { jobId });
}

/**
 * Records the event for every active endpoint subscribed to it and queues delivery. The
 * worker retries failures (WEBHOOK_RETRY_DELAYS_MS). Never throws into the caller's flow:
 * a delivery that cannot be queued is still recorded as pending and picked up by the sweeper.
 */
export async function dispatchWebhookEvent(organizationId: string, event: WebhookEventType, data: Record<string, unknown>) {
  const webhooks = await prisma.webhook.findMany({ where: { organizationId, isActive: true } });
  const targets = webhooks.filter((w) => w.subscribedTo.includes("*") || w.subscribedTo.includes(event));
  if (targets.length === 0) return;
  const payload = makePayload(event, data);
  for (const webhook of targets) {
    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        event,
        messageId: newMessageId(),
        payload: payload as unknown as Prisma.InputJsonObject,
        status: "pending",
        nextAttemptAt: new Date(),
      },
    });
    await queueWebhookDelivery(delivery.id).catch((err) => console.error(`[webhooks] could not queue ${delivery.id}`, err));
  }
}

/** Sends a delivery again from the start, with the same message id. */
export async function replayWebhookDelivery(deliveryId: string) {
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: "pending", nextAttemptAt: new Date() },
  });
  await queueWebhookDelivery(deliveryId, `${deliveryId}:replay:${Date.now()}`);
}
