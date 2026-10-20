/** Events TredMail can send to webhook endpoints. Kept free of imports so the OpenAPI spec can use it. */
export const WEBHOOK_EVENT_TYPES = [
  "email.queued",
  "email.scheduled",
  "email.canceled",
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
