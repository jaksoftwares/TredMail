import { z } from "zod";

const emailOrList = z.union([z.string().email(), z.array(z.string().email())]);

export const MAX_SCHEDULE_DAYS = 30;

export const sendEmailSchema = z.object({
  // Optional only when the template sets a default sender
  from: z.string().min(3).max(320).optional(),
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
  cc: emailOrList.optional(),
  bcc: emailOrList.optional(),
  reply_to: z.string().email().optional(),
  // Optional only when a template supplies it
  subject: z.string().min(1).max(998).optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  headers: z.record(z.string()).optional(),
  tags: z.array(z.object({ name: z.string().max(256), value: z.string().max(256) })).max(50).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        content: z.string(), // base64
        content_type: z.string().optional(),
        // Set to embed the file inline: reference it in the HTML as <img src="cid:...">
        content_id: z.string().max(255).optional(),
      })
    )
    .max(20)
    .optional(),
  track_opens: z.boolean().optional(),
  track_clicks: z.boolean().optional(),
  // Template id or alias; its subject, html and text are rendered with `variables`
  template: z.string().min(1).max(128).optional(),
  variables: z.record(z.unknown()).optional(),
  // ISO 8601 time, up to 30 days ahead
  scheduled_at: z.string().datetime({ offset: true }).optional(),
});

export type SendEmailInput = z.infer<typeof sendEmailSchema>;

// Headers TredMail controls. Letting callers set these allows spoofing or breaks signing.
const RESERVED_HEADERS = new Set([
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "return-path",
  "received",
  "dkim-signature",
  "arc-seal",
  "arc-message-signature",
  "arc-authentication-results",
  "authentication-results",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "feedback-id",
]);

export function findReservedHeaders(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.keys(headers).filter((name) => {
    const lower = name.toLowerCase();
    return RESERVED_HEADERS.has(lower) || lower.startsWith("x-tredmail-") || /[\r\n:]/.test(name);
  });
}

const addressSchema = z.string().email();

/** Extracts the address from `Name <user@domain>` or `user@domain`; null if invalid. */
export function parseFromAddress(from: string): { address: string; domain: string } | null {
  const bracketed = from.match(/<([^<>]+)>\s*$/);
  const address = (bracketed ? bracketed[1] : from).trim().toLowerCase();
  if (!addressSchema.safeParse(address).success) return null;
  return { address, domain: address.split("@")[1] };
}
