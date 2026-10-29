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
  headers: z.record(z.string(), z.string()).optional(),
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
  variables: z.record(z.string(), z.unknown()).optional(),
  // ISO 8601 time, up to 30 days ahead
  scheduled_at: z.string().datetime({ offset: true }).optional(),
  // Adds TredMail's one-click unsubscribe (List-Unsubscribe and List-Unsubscribe-Post,
  // RFC 8058). The recipient is added to the suppression list when they use it.
  unsubscribe: z.boolean().optional(),
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
  "feedback-id",
]);

export function findReservedHeaders(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.keys(headers).filter((name) => {
    const lower = name.toLowerCase();
    return RESERVED_HEADERS.has(lower) || lower.startsWith("x-tredmail-") || /[\r\n:]/.test(name);
  });
}

const headerValue = (headers: Record<string, string> | undefined, name: string) =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

/**
 * Checks List-Unsubscribe headers a sender sets themselves: one or more `<https://...>` or
 * `<mailto:...>` entries, and List-Unsubscribe-Post (RFC 8058) only as `List-Unsubscribe=One-Click`
 * next to an https entry. They cannot be combined with TredMail's own (`unsubscribe: true`).
 * Returns what is wrong, or null.
 */
export function checkListUnsubscribeHeaders(headers: Record<string, string> | undefined, tredmailUnsubscribe: boolean): string | null {
  const list = headerValue(headers, "list-unsubscribe");
  const post = headerValue(headers, "list-unsubscribe-post");
  if (list === undefined && post === undefined) return null;
  if (tredmailUnsubscribe) return "Set either unsubscribe: true or your own List-Unsubscribe headers, not both.";
  if (list === undefined) return "List-Unsubscribe-Post needs a List-Unsubscribe header.";
  const entries = list.split(",").map((part) => part.trim());
  const valid = entries.every((entry) => /^<(https:\/\/[^\s<>]+|mailto:[^\s<>]+)>$/i.test(entry));
  if (!valid) return "List-Unsubscribe must be one or more <https://...> or <mailto:...> entries, separated by commas.";
  if (post !== undefined) {
    if (post.trim() !== "List-Unsubscribe=One-Click") return "List-Unsubscribe-Post must be exactly 'List-Unsubscribe=One-Click'.";
    if (!entries.some((entry) => /^<https:/i.test(entry))) return "One-click unsubscribe (List-Unsubscribe-Post) needs an https:// entry in List-Unsubscribe.";
  }
  return null;
}

/** Removes suppressed addresses from each recipient list (case-insensitive), keeping order. */
export function withoutSuppressed(
  recipients: { to: string[]; cc: string[]; bcc: string[] },
  suppressed: Set<string>,
): { to: string[]; cc: string[]; bcc: string[]; removed: string[] } {
  const removed: string[] = [];
  const keep = (list: string[]) =>
    list.filter((address) => {
      if (!suppressed.has(address.toLowerCase())) return true;
      removed.push(address.toLowerCase());
      return false;
    });
  return { to: keep(recipients.to), cc: keep(recipients.cc), bcc: keep(recipients.bcc), removed: [...new Set(removed)] };
}

const addressSchema = z.string().email();

/** Extracts the address from `Name <user@domain>` or `user@domain`; null if invalid. */
export function parseFromAddress(from: string): { address: string; domain: string } | null {
  const bracketed = from.match(/<([^<>]+)>\s*$/);
  const address = (bracketed ? bracketed[1] : from).trim().toLowerCase();
  if (!addressSchema.safeParse(address).success) return null;
  return { address, domain: address.split("@")[1] };
}
