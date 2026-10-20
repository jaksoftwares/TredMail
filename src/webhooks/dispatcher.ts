import crypto from "crypto";
import type { Prisma, Webhook } from "@prisma/client";
import { prisma } from "../db/client.js";
import { env } from "../config/env.js";
import { assertPublicHttpUrl } from "../security/url-safety.js";

export const WEBHOOK_EVENT_TYPES = [
  "email.queued",
  "email.sent",
  "email.delivered",
  "email.deferred",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

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

/** Delivers one event to one endpoint and records the attempt. Never throws. */
export async function deliverWebhook(webhook: Webhook, event: WebhookEventType, data: Record<string, unknown>) {
  const messageId = `msg_${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = { type: event, created_at: new Date(timestamp * 1000).toISOString(), data };
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
        "X-TredMail-Event": event,
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

  await prisma.webhookDelivery
    .create({ data: { webhookId: webhook.id, event, payload: payload as Prisma.InputJsonObject, statusCode, response, success } })
    .catch((err) => console.error("failed to record webhook delivery", err));

  return { success, statusCode };
}

/**
 * Sends an event to every active endpoint of the organization subscribed to it.
 * Single attempt for now; queued retries arrive with webhooks v2 (roadmap Phase 3).
 */
export async function dispatchWebhookEvent(
  organizationId: string,
  event: WebhookEventType,
  data: Record<string, unknown>
) {
  const webhooks = await prisma.webhook.findMany({ where: { organizationId, isActive: true } });
  const targets = webhooks.filter((w) => w.subscribedTo.includes("*") || w.subscribedTo.includes(event));
  await Promise.all(targets.map((webhook) => deliverWebhook(webhook, event, data)));
}
