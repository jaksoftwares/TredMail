/**
 * TredMail Node.js SDK by Dovepeak Technologies.
 *
 *   import { TredMail } from "@dovepeak/tredmail";
 *   const tredmail = new TredMail({ apiKey: process.env.TREDMAIL_API_KEY! });
 *   const { data, error } = await tredmail.emails.send({
 *     from: "Dovepeak <billing@dovepeakdigital.com>",
 *     to: "customer@example.com",
 *     subject: "Your receipt",
 *     html: "<p>Thank you</p>",
 *   });
 *
 * Every method resolves to `{ data, error }` and never throws for API errors, so callers can
 * branch on `error` (network failures are reported the same way, with statusCode 0).
 * Requires Node.js 18+ (global fetch and Web Crypto).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_BASE_URL = "https://api.tredmail.dovepeakdigital.com/v1";

export interface TredMailConfig {
  apiKey: string;
  /** Defaults to the production API. */
  baseUrl?: string;
  /** Per-request timeout. Default 30 seconds. */
  timeoutMs?: number;
  /** Custom fetch, e.g. for tests or proxies. */
  fetch?: typeof fetch;
}

export interface TredMailError {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}

export type Result<T> = { data: T; error: null } | { data: null; error: TredMailError };

export interface RequestOptions {
  /** Makes a send safe to retry: the same key returns the original result for 24 hours. */
  idempotencyKey?: string;
}

export interface Attachment {
  filename: string;
  /** Base64 string, or a Buffer that is encoded for you. */
  content: string | Buffer;
  contentType?: string;
  /** Embed inline and reference in the HTML as <img src="cid:..."> */
  contentId?: string;
}

export interface SendEmailOptions {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject?: string;
  html?: string;
  text?: string;
  /** Template id or alias; its subject and bodies are rendered with `variables`. */
  template?: string;
  variables?: Record<string, unknown>;
  /** Send later (up to 30 days ahead). */
  scheduledAt?: Date | string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  attachments?: Attachment[];
  trackOpens?: boolean;
  trackClicks?: boolean;
}

export type EmailStatus = "scheduled" | "canceled" | "queued" | "sending" | "sent" | "delivered" | "failed" | "bounced" | "complained";

export interface EmailAccepted {
  id: string;
  from: string;
  to: string[];
  status: "queued" | "scheduled";
  scheduled_at: string | null;
  created_at: string;
}

export interface EmailSummary {
  id: string;
  from: string;
  to: string[];
  subject: string;
  status: EmailStatus;
  created_at: string;
  scheduled_at: string | null;
  delivered_at: string | null;
}

export interface EmailEvent {
  id: string;
  type: string;
  timestamp: string;
  ip_address: string | null;
  user_agent: string | null;
  link_url: string | null;
  details: Record<string, unknown> | null;
}

export interface Email extends EmailSummary {
  domain: string;
  cc: string[];
  bcc: string[];
  reply_to: string | null;
  html: string | null;
  text: string | null;
  tags: Array<{ name: string; value: string }> | null;
  template: { id: string; alias: string } | null;
  attachments: Array<{ filename: string; content_type: string | null; size: number }>;
  smtp_response: string | null;
  events: EmailEvent[];
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface ListEmailsOptions {
  status?: EmailStatus | EmailStatus[];
  q?: string;
  domain?: string;
  tag?: string;
  template?: string;
  after?: Date | string;
  before?: Date | string;
  limit?: number;
  cursor?: string;
}

export interface TemplateInput {
  name: string;
  alias: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  from?: string | null;
  replyTo?: string | null;
}

export interface Template {
  id: string;
  name: string;
  alias: string;
  subject: string;
  html: string | null;
  text: string | null;
  from: string | null;
  reply_to: string | null;
  variables: string[];
  created_at: string;
  updated_at: string;
}

export interface DnsRecord {
  recordType: "DKIM" | "SPF" | "DMARC" | "RETURN_PATH";
  type: "TXT" | "CNAME";
  name: string;
  host: string;
  expectedValue: string;
  ttl: string;
  verified?: boolean;
}

export interface Domain {
  id: string;
  name: string;
  status: "pending" | "verified" | "failed";
  region?: string;
  created_at: string;
  records: DnsRecord[];
}

export interface Webhook {
  id: string;
  url: string;
  subscribed_to: string[];
  is_active: boolean;
  total_deliveries?: number;
  failed_deliveries_7d?: number;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  message_id: string | null;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  status_code: number | null;
  response: string | null;
  payload: WebhookEvent;
  created_at: string;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
}

export interface WebhookEvent<T = Record<string, unknown>> {
  type: string;
  created_at: string;
  data: T;
}

export interface Suppression {
  id: string;
  email: string;
  reason: string;
  diagnostic: string | null;
  created_at: string;
}

const toBase64 = (content: string | Buffer) => (typeof content === "string" ? content : content.toString("base64"));
const toIso = (value: Date | string | undefined) => (value instanceof Date ? value.toISOString() : value);

/** Maps the SDK's camelCase options to the API's snake_case request body. */
export function toSendRequest(options: SendEmailOptions) {
  return {
    from: options.from,
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    reply_to: options.replyTo,
    subject: options.subject,
    html: options.html,
    text: options.text,
    template: options.template,
    variables: options.variables,
    scheduled_at: toIso(options.scheduledAt),
    headers: options.headers,
    tags: options.tags,
    attachments: options.attachments?.map((a) => ({
      filename: a.filename,
      content: toBase64(a.content),
      content_type: a.contentType,
      content_id: a.contentId,
    })),
    track_opens: options.trackOpens,
    track_clicks: options.trackClicks,
  };
}

const templateBody = (t: Partial<TemplateInput>) => ({
  name: t.name,
  alias: t.alias,
  subject: t.subject,
  html: t.html,
  text: t.text,
  from: t.from,
  reply_to: t.replyTo,
});

function queryString(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export class TredMail {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TredMailConfig) {
    if (!config?.apiKey) throw new Error("TredMail API key is required: new TredMail({ apiKey: 'tred_live_...' })");
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchImpl = config.fetch ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<Result<T>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, "User-Agent": "tredmail-node/1.3.0" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const err = (json ?? {}) as Partial<TredMailError>;
        return {
          data: null,
          error: { statusCode: res.status, error: err.error ?? "http_error", message: err.message ?? res.statusText, details: err.details },
        };
      }
      return { data: json as T, error: null };
    } catch (err) {
      return { data: null, error: { statusCode: 0, error: "network_error", message: err instanceof Error ? err.message : String(err) } };
    }
  }

  readonly emails = {
    send: (options: SendEmailOptions, requestOptions?: RequestOptions) =>
      this.request<EmailAccepted>("POST", "/emails", toSendRequest(options), requestOptions),
    batch: (emails: SendEmailOptions[], requestOptions?: RequestOptions) =>
      this.request<{ data: Array<EmailAccepted | { error: string; message: string }> }>("POST", "/emails/batch", emails.map(toSendRequest), requestOptions),
    get: (id: string) => this.request<Email>("GET", `/emails/${encodeURIComponent(id)}`),
    list: (options: ListEmailsOptions = {}) =>
      this.request<Page<EmailSummary>>(
        "GET",
        `/emails${queryString({
          status: Array.isArray(options.status) ? options.status.join(",") : options.status,
          q: options.q,
          domain: options.domain,
          tag: options.tag,
          template: options.template,
          after: toIso(options.after),
          before: toIso(options.before),
          limit: options.limit,
          cursor: options.cursor,
        })}`,
      ),
    cancel: (id: string) => this.request<{ id: string; status: "canceled" }>("POST", `/emails/${encodeURIComponent(id)}/cancel`),
    reschedule: (id: string, scheduledAt: Date | string) =>
      this.request<{ id: string; status: string; scheduled_at: string | null }>("PATCH", `/emails/${encodeURIComponent(id)}`, {
        scheduled_at: toIso(scheduledAt),
      }),
  };

  readonly templates = {
    list: () => this.request<{ data: Template[] }>("GET", "/templates"),
    get: (idOrAlias: string) => this.request<Template>("GET", `/templates/${encodeURIComponent(idOrAlias)}`),
    create: (template: TemplateInput) => this.request<Template>("POST", "/templates", templateBody(template)),
    update: (idOrAlias: string, changes: Partial<TemplateInput>) =>
      this.request<Template>("PATCH", `/templates/${encodeURIComponent(idOrAlias)}`, templateBody(changes)),
    remove: (idOrAlias: string) => this.request<{ id: string; deleted: true }>("DELETE", `/templates/${encodeURIComponent(idOrAlias)}`),
    preview: (idOrAlias: string, variables: Record<string, unknown> = {}) =>
      this.request<{ subject: string; html: string | null; text: string | null; missing_variables: string[] }>(
        "POST",
        `/templates/${encodeURIComponent(idOrAlias)}/preview`,
        { variables },
      ),
  };

  readonly domains = {
    list: () => this.request<{ data: Domain[] }>("GET", "/domains"),
    get: (id: string) => this.request<Domain>("GET", `/domains/${encodeURIComponent(id)}`),
    create: (name: string) => this.request<Domain>("POST", "/domains", { name }),
    verify: (id: string) => this.request<{ id: string; status: string; report: unknown }>("POST", `/domains/${encodeURIComponent(id)}/verify`),
    remove: (id: string) => this.request<{ id: string; deleted: true }>("DELETE", `/domains/${encodeURIComponent(id)}`),
    dmarc: (id: string, days = 30) => this.request<Record<string, unknown>>("GET", `/domains/${encodeURIComponent(id)}/dmarc?days=${days}`),
  };

  readonly webhooks = {
    list: () => this.request<{ data: Webhook[] }>("GET", "/webhooks"),
    create: (url: string, events: string[] = ["email.delivered", "email.bounced"]) =>
      this.request<Webhook & { secret: string }>("POST", "/webhooks", { url, subscribed_to: events }),
    update: (id: string, changes: { url?: string; events?: string[]; active?: boolean }) =>
      this.request<Webhook>("PATCH", `/webhooks/${encodeURIComponent(id)}`, { url: changes.url, subscribed_to: changes.events, is_active: changes.active }),
    remove: (id: string) => this.request<{ success: boolean }>("DELETE", `/webhooks/${encodeURIComponent(id)}`),
    test: (id: string) => this.request<{ success: boolean; status_code: number; message: string }>("POST", `/webhooks/${encodeURIComponent(id)}/test`),
    rotateSecret: (id: string) => this.request<{ id: string; secret: string }>("POST", `/webhooks/${encodeURIComponent(id)}/rotate-secret`),
    deliveries: (id: string, options: { status?: "pending" | "succeeded" | "failed"; limit?: number; cursor?: string } = {}) =>
      this.request<Page<WebhookDelivery>>("GET", `/webhooks/${encodeURIComponent(id)}/deliveries${queryString(options)}`),
    replay: (id: string, deliveryId: string) =>
      this.request<{ id: string; status: string }>("POST", `/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`),
    replayFailed: (id: string) => this.request<{ replayed: number }>("POST", `/webhooks/${encodeURIComponent(id)}/replay-failed`),
  };

  readonly suppressions = {
    list: () => this.request<{ data: Suppression[] }>("GET", "/suppressions"),
    create: (email: string, reason: "HARD_BOUNCE" | "SPAM_COMPLAINT" | "UNSUBSCRIBE" | "MANUAL" = "MANUAL") =>
      this.request<Suppression>("POST", "/suppressions", { email, reason }),
    remove: (id: string) => this.request<{ success: boolean }>("DELETE", `/suppressions/${encodeURIComponent(id)}`),
  };

  readonly apiKeys = {
    list: () => this.request<{ data: Array<Record<string, unknown>> }>("GET", "/api-keys"),
    create: (name: string, scopes: string[] = ["emails:send"], expiresAt?: Date | string) =>
      this.request<{ id: string; name: string; token: string; scopes: string[] }>("POST", "/api-keys", { name, scopes, expires_at: toIso(expiresAt) }),
    revoke: (id: string) => this.request<Record<string, unknown>>("DELETE", `/api-keys/${encodeURIComponent(id)}`),
  };

  readonly stats = {
    get: () => this.request<{ metrics: Record<string, unknown>; recentEmails: unknown[] }>("GET", "/stats"),
    timeseries: (days = 30, domain?: string) =>
      this.request<{ days: number; start: string; data: Array<Record<string, number | string>> }>("GET", `/stats/timeseries${queryString({ days, domain })}`),
    domains: (days = 30) => this.request<{ days: number; data: Array<Record<string, unknown>> }>("GET", `/stats/domains?days=${days}`),
  };
}

// ---------------------------------------------------------------------------
// Webhook verification (Standard Webhooks)
// ---------------------------------------------------------------------------

export class WebhookVerificationError extends Error {}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()] ?? Object.entries(record).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Verifies a TredMail webhook and returns the parsed event. Pass the raw request body
 * exactly as received (not re-serialized JSON). Throws WebhookVerificationError when the
 * signature is wrong or the timestamp is older than `toleranceSeconds` (default 5 minutes).
 *
 *   app.post("/hooks/tredmail", express.raw({ type: "application/json" }), (req, res) => {
 *     const event = verifyWebhook({ secret: process.env.TREDMAIL_WEBHOOK_SECRET!, headers: req.headers, body: req.body });
 *     ...
 *   });
 */
export function verifyWebhook<T = Record<string, unknown>>(input: {
  secret: string;
  headers: HeaderSource;
  body: string | Buffer;
  toleranceSeconds?: number;
  now?: Date;
}): WebhookEvent<T> {
  const id = header(input.headers, "webhook-id");
  const timestamp = header(input.headers, "webhook-timestamp");
  const signatures = header(input.headers, "webhook-signature");
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header");

  const seconds = Number(timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds) > (input.toleranceSeconds ?? 300)) {
    throw new WebhookVerificationError("Webhook timestamp is too old or in the future");
  }

  const body = typeof input.body === "string" ? input.body : input.body.toString("utf8");
  const key = Buffer.from(input.secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64"));
  // The header may carry several space-separated signatures (during secret rotation)
  const valid = signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || !signature) return false;
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new WebhookVerificationError("Webhook signature does not match");
  return JSON.parse(body) as WebhookEvent<T>;
}

export default TredMail;
