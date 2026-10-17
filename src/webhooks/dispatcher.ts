import crypto from "crypto";
import { prisma } from "../db/client.js";

export type WebhookEventType =
  | "email.queued"
  | "email.delivered"
  | "email.opened"
  | "email.clicked"
  | "email.bounced"
  | "email.complained";

/**
 * Computes an HMAC-SHA256 signature for webhook payload verification.
 */
export function signWebhookPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Dispatches a real-time event to all subscribed webhooks for an organization.
 */
export async function dispatchWebhookEvent(
  organizationId: string,
  event: WebhookEventType,
  data: Record<string, any>
) {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: {
        organizationId,
        isActive: true,
      },
    });

    if (webhooks.length === 0) return;

    const payloadObject = {
      event,
      created_at: new Date().toISOString(),
      data,
    };
    const payloadString = JSON.stringify(payloadObject);

    for (const webhook of webhooks) {
      // Check if webhook is subscribed to this event or to "*"
      if (
        webhook.subscribedTo.includes("*") ||
        webhook.subscribedTo.includes(event)
      ) {
        const signature = signWebhookPayload(payloadString, webhook.secret);

        fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "TredMail-Webhook/1.0",
            "X-TredMail-Event": event,
            "X-TredMail-Signature": `sha256=${signature}`,
            "X-TredMail-Timestamp": new Date().toISOString(),
          },
          body: payloadString,
          signal: AbortSignal.timeout(10000), // 10 second timeout
        })
          .then(async (res) => {
            const responseText = await res.text().catch(() => "");
            await prisma.webhookDelivery.create({
              data: {
                webhookId: webhook.id,
                event,
                payload: payloadObject,
                statusCode: res.status,
                response: responseText.substring(0, 1000),
                success: res.ok,
              },
            });
          })
          .catch(async (err) => {
            console.warn(`⚠️ Webhook delivery failed for ${webhook.url}:`, err.message);
            await prisma.webhookDelivery.create({
              data: {
                webhookId: webhook.id,
                event,
                payload: payloadObject,
                statusCode: 0,
                response: err.message,
                success: false,
              },
            });
          });
      }
    }
  } catch (err: any) {
    console.error("❌ Failed to process webhooks:", err.message);
  }
}
