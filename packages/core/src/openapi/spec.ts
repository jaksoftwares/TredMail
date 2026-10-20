/**
 * OpenAPI 3.1 description of TredMail's public API. Served at GET /v1/openapi.json and
 * rendered by the console's API reference (/docs/api). tests/openapi.test.ts fails when a
 * public route is missing from here, so keep it in step with apps/api/src/routes.
 */
import { API_SCOPES } from "../security/scopes.js";
import { WEBHOOK_EVENT_TYPES } from "../webhooks/events.js";

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string, extra: Schema = {}): Schema => ({ type: "string", ...(description ? { description } : {}), ...extra });
const int = (description?: string, extra: Schema = {}): Schema => ({ type: "integer", ...(description ? { description } : {}), ...extra });
const bool = (description?: string): Schema => ({ type: "boolean", ...(description ? { description } : {}) });
const arr = (items: Schema, description?: string): Schema => ({ type: "array", items, ...(description ? { description } : {}) });
const obj = (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  ...(description ? { description } : {}),
});
const dateTime = (description?: string) => str(description, { format: "date-time" });
const nullable = (schema: Schema): Schema => ({ ...schema, type: [schema.type as string, "null"] });

const json = (schema: Schema, example?: unknown) => ({
  "application/json": { schema, ...(example !== undefined ? { example } : {}) },
});
const ok = (description: string, schema: Schema, example?: unknown) => ({ description, content: json(schema, example) });
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [String(code), { $ref: `#/components/responses/Error${code}` }]));
const body = (schema: Schema, example?: unknown, required = true) => ({ required, content: json(schema, example) });

const idParam = (description = "Resource id") => ({ name: "id", in: "path", required: true, schema: str(), description });
const query = (name: string, schema: Schema, description: string) => ({ name, in: "query", required: false, schema, description });
const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: str(undefined, { maxLength: 256 }),
  description:
    "Makes the request safe to retry: the same key and body within 24 hours return the original response (with `Idempotent-Replayed: true`) instead of sending again.",
};
const cursorParams = [
  query("limit", int(undefined, { minimum: 1, maximum: 100, default: 25 }), "Page size."),
  query("cursor", str(), "The `next_cursor` from the previous page."),
];

const op = (summary: string, tags: string[], scope: string | null, extra: Schema) => ({
  summary,
  tags,
  ...(scope ? { "x-required-scope": scope, description: `${(extra.description as string | undefined) ?? ""}${extra.description ? "\n\n" : ""}Requires the \`${scope}\` scope.` } : {}),
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "description")),
});

const exampleEmailId = "cmvgkysyx0009ixtdd4hv89d7";

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "TredMail API",
    version: "1.4.0",
    description:
      "Transactional email API by Dovepeak Technologies. Authenticate with `Authorization: Bearer tred_live_...`. " +
      "Request and response bodies are JSON with snake_case fields. Errors share one shape: `{ statusCode, error, message }`.",
    contact: { name: "Dovepeak Technologies", url: "https://dovepeakdigital.com" },
  },
  servers: [{ url: "https://api.tredmail.dovepeakdigital.com/v1", description: "Production" }],
  security: [{ apiKey: [] }],
  tags: [
    { name: "Emails", description: "Send, schedule, cancel and inspect emails." },
    { name: "Templates", description: "Reusable content with {{variables}}." },
    { name: "Domains", description: "Sending domains and their DNS records." },
    { name: "Webhooks", description: "Event notifications to your endpoints, signed with Standard Webhooks." },
    { name: "Suppressions", description: "Addresses TredMail will not send to." },
    { name: "API keys", description: "Keys for applications and services." },
    { name: "Stats", description: "Sending and engagement metrics." },
    { name: "Usage and plans", description: "This month's usage against the workspace's plan, and the public price list." },
  ],
  paths: {
    "/emails": {
      post: op("Send an email", ["Emails"], "emails:send", {
        description:
          "Queues one email. Give `html`, `text` or both, or a `template` with `variables`. With `scheduled_at` the email waits until that time (up to 30 days).",
        parameters: [idempotencyHeader],
        requestBody: body(ref("SendEmailRequest"), {
          from: "Dovepeak Billing <billing@dovepeakdigital.com>",
          to: ["customer@example.com"],
          subject: "Your receipt",
          html: "<p>Thank you for your payment.</p>",
          tags: [{ name: "category", value: "receipt" }],
        }),
        responses: { "200": ok("Accepted", ref("EmailAccepted")), ...errors(400, 401, 403, 404, 409, 422, 429) },
      }),
      get: op("List emails", ["Emails"], "emails:read", {
        description: "Newest first.",
        parameters: [
          query("status", str("One or more statuses, comma separated, e.g. `bounced,failed`."), "Filter by status."),
          query("q", str(), "Search subject, sender, recipient or email id."),
          query("domain", str(), "Sending domain name."),
          query("tag", str(), "`name` or `name:value`."),
          query("template", str(), "Template id or alias."),
          query("after", dateTime(), "Created at or after this time."),
          query("before", dateTime(), "Created before this time."),
          ...cursorParams,
        ],
        responses: { "200": ok("A page of emails", obj({ data: arr(ref("EmailSummary")), next_cursor: nullable(str()) })), ...errors(400, 401, 403) },
      }),
    },
    "/emails/batch": {
      post: op("Send up to 100 emails", ["Emails"], "emails:send", {
        description: "Each email is accepted or rejected independently; the response lists results in request order. Also available at `POST /batch`.",
        parameters: [idempotencyHeader],
        requestBody: body(arr(ref("SendEmailRequest"))),
        responses: {
          "200": ok("Per-email results", obj({ data: arr({ oneOf: [ref("EmailAccepted"), obj({ error: str(), message: str() })] }) })),
          ...errors(400, 401, 403, 409, 422),
        },
      }),
    },
    "/batch": {
      post: op("Send up to 100 emails (alias)", ["Emails"], "emails:send", {
        description: "Same as `POST /emails/batch`.",
        parameters: [idempotencyHeader],
        requestBody: body(arr(ref("SendEmailRequest"))),
        responses: { "200": ok("Per-email results", obj({ data: arr({}) })), ...errors(400, 401, 403) },
      }),
    },
    "/emails/{id}": {
      get: op("Get an email", ["Emails"], "emails:read", {
        description: "The email with its full event timeline.",
        parameters: [idParam("Email id")],
        responses: { "200": ok("The email", ref("Email")), ...errors(401, 403, 404) },
      }),
      patch: op("Reschedule an email", ["Emails"], "emails:send", {
        description: "Moves a scheduled email to a new time. A time in the past sends it now.",
        parameters: [idParam("Email id")],
        requestBody: body(obj({ scheduled_at: dateTime() }, ["scheduled_at"])),
        responses: {
          "200": ok("Rescheduled", obj({ id: str(), status: str(undefined, { enum: ["scheduled", "queued"] }), scheduled_at: nullable(dateTime()) })),
          ...errors(400, 401, 403, 404, 409, 422),
        },
      }),
    },
    "/emails/{id}/cancel": {
      post: op("Cancel a scheduled email", ["Emails"], "emails:send", {
        parameters: [idParam("Email id")],
        responses: { "200": ok("Canceled", obj({ id: str(), status: str(undefined, { const: "canceled" }) })), ...errors(401, 403, 404, 409) },
      }),
    },
    "/templates": {
      get: op("List templates", ["Templates"], "templates:manage", {
        responses: { "200": ok("Templates", obj({ data: arr(ref("Template")) })), ...errors(401, 403) },
      }),
      post: op("Create a template", ["Templates"], "templates:manage", {
        requestBody: body(ref("TemplateInput"), {
          name: "Password reset",
          alias: "password-reset",
          subject: "Reset your {{product|Dovepeak}} password",
          html: "<p>Hi {{name}},</p><p><a href=\"{{{reset_url}}}\">Choose a new password</a></p>",
        }),
        responses: { "201": ok("Created", ref("Template")), ...errors(400, 401, 403, 409) },
      }),
    },
    "/templates/{id}": {
      get: op("Get a template", ["Templates"], "templates:manage", {
        parameters: [idParam("Template id or alias")],
        responses: { "200": ok("The template", ref("Template")), ...errors(401, 403, 404) },
      }),
      patch: op("Update a template", ["Templates"], "templates:manage", {
        parameters: [idParam("Template id or alias")],
        requestBody: body({ ...ref("TemplateInput"), description: "Any subset of the fields." }),
        responses: { "200": ok("Updated", ref("Template")), ...errors(400, 401, 403, 404, 409) },
      }),
      delete: op("Delete a template", ["Templates"], "templates:manage", {
        parameters: [idParam("Template id or alias")],
        responses: { "200": ok("Deleted", obj({ id: str(), deleted: bool() })), ...errors(401, 403, 404) },
      }),
    },
    "/templates/{id}/preview": {
      post: op("Preview a template", ["Templates"], "templates:manage", {
        description: "Renders the template with sample variables without sending anything.",
        parameters: [idParam("Template id or alias")],
        requestBody: body(obj({ variables: { type: "object", additionalProperties: true } }), { variables: { name: "Amina" } }, false),
        responses: {
          "200": ok("Rendered", obj({ subject: str(), html: nullable(str()), text: nullable(str()), missing_variables: arr(str()) })),
          ...errors(400, 401, 403, 404),
        },
      }),
    },
    "/domains": {
      get: op("List domains", ["Domains"], "domains:read", {
        responses: { "200": ok("Domains", obj({ data: arr(ref("Domain")) })), ...errors(401, 403) },
      }),
      post: op("Add a domain", ["Domains"], "domains:manage", {
        description: "Creates the domain with a fresh 2048-bit DKIM key and returns the DNS records to publish.",
        requestBody: body(obj({ name: str("e.g. `acme.com` or `mail.acme.com`") }, ["name"]), { name: "acme.com" }),
        responses: { "201": ok("Created", ref("Domain")), ...errors(400, 401, 403, 409, 422) },
      }),
    },
    "/domains/{id}": {
      get: op("Get a domain", ["Domains"], "domains:read", {
        description: "Includes each DNS record with whether it was found at the last verification.",
        parameters: [idParam("Domain id")],
        responses: { "200": ok("The domain", ref("Domain")), ...errors(401, 403, 404) },
      }),
      delete: op("Delete a domain", ["Domains"], "domains:manage", {
        description: "Refused while emails from the domain are still waiting to be sent.",
        parameters: [idParam("Domain id")],
        responses: { "200": ok("Deleted", obj({ id: str(), deleted: bool() })), ...errors(401, 403, 404, 409) },
      }),
    },
    "/domains/{id}/verify": {
      post: op("Verify a domain's DNS", ["Domains"], "domains:manage", {
        description: "Looks up DKIM, SPF, DMARC and the return path in public DNS and updates the domain's status.",
        parameters: [idParam("Domain id")],
        responses: { "200": ok("Verification result", obj({ id: str(), status: str(), report: { type: "object" } })), ...errors(401, 403, 404) },
      }),
    },
    "/domains/{id}/dmarc": {
      get: op("DMARC report summary", ["Domains"], "domains:read", {
        description: "Totals from the DMARC aggregate reports mailbox providers sent for this domain (its `rua=` must point at TredMail).",
        parameters: [idParam("Domain id"), query("days", int(undefined, { minimum: 1, maximum: 365, default: 30 }), "Period.")],
        responses: { "200": ok("Summary", ref("DmarcSummary")), ...errors(401, 403, 404) },
      }),
    },
    "/webhooks": {
      get: op("List webhook endpoints", ["Webhooks"], "webhooks:manage", {
        responses: { "200": ok("Endpoints", obj({ data: arr(ref("Webhook")) })), ...errors(401, 403) },
      }),
      post: op("Create a webhook endpoint", ["Webhooks"], "webhooks:manage", {
        description: "The response contains the signing `secret`, shown only once.",
        requestBody: body(obj({ url: str(undefined, { format: "uri" }), subscribed_to: arr(ref("WebhookEventType")) }, ["url"]), {
          url: "https://billing.dovepeakdigital.com/hooks/tredmail",
          subscribed_to: ["email.delivered", "email.bounced", "email.complained"],
        }),
        responses: { "201": ok("Created", { allOf: [ref("Webhook"), obj({ secret: str() })] }), ...errors(400, 401, 403, 422) },
      }),
    },
    "/webhooks/{id}": {
      patch: op("Update a webhook endpoint", ["Webhooks"], "webhooks:manage", {
        description: "Change the URL or events, or pause (`is_active: false`) and resume.",
        parameters: [idParam("Webhook id")],
        requestBody: body(obj({ url: str(undefined, { format: "uri" }), subscribed_to: arr(ref("WebhookEventType")), is_active: bool() })),
        responses: { "200": ok("Updated", ref("Webhook")), ...errors(400, 401, 403, 404, 422) },
      }),
      delete: op("Delete a webhook endpoint", ["Webhooks"], "webhooks:manage", {
        parameters: [idParam("Webhook id")],
        responses: { "200": ok("Deleted", obj({ success: bool(), message: str() })), ...errors(401, 403, 404) },
      }),
    },
    "/webhooks/{id}/test": {
      post: op("Send a test event", ["Webhooks"], "webhooks:manage", {
        description: "Delivers one `email.delivered` test event right away (no retries) and reports the result.",
        parameters: [idParam("Webhook id")],
        responses: { "200": ok("Result", obj({ success: bool(), status_code: int(), message: str() })), ...errors(401, 403, 404) },
      }),
    },
    "/webhooks/{id}/rotate-secret": {
      post: op("Rotate the signing secret", ["Webhooks"], "webhooks:manage", {
        description: "Issues a new secret, shown once. Deliveries are signed with it immediately.",
        parameters: [idParam("Webhook id")],
        responses: { "200": ok("New secret", obj({ id: str(), secret: str() })), ...errors(401, 403, 404) },
      }),
    },
    "/webhooks/{id}/deliveries": {
      get: op("List deliveries", ["Webhooks"], "webhooks:manage", {
        description: "Every event sent to the endpoint, with attempts and the last response. Failed deliveries are retried for about 27 hours.",
        parameters: [idParam("Webhook id"), query("status", str(undefined, { enum: ["pending", "succeeded", "failed"] }), "Filter."), ...cursorParams],
        responses: { "200": ok("A page of deliveries", obj({ data: arr(ref("WebhookDelivery")), next_cursor: nullable(str()) })), ...errors(400, 401, 403, 404) },
      }),
    },
    "/webhooks/{id}/deliveries/{deliveryId}/replay": {
      post: op("Replay a delivery", ["Webhooks"], "webhooks:manage", {
        description: "Sends the same event again with the same `webhook-id`, so receivers can drop duplicates.",
        parameters: [idParam("Webhook id"), { name: "deliveryId", in: "path", required: true, schema: str() }],
        responses: { "202": ok("Queued", obj({ id: str(), status: str() })), ...errors(401, 403, 404, 409) },
      }),
    },
    "/webhooks/{id}/replay-failed": {
      post: op("Replay all failed deliveries", ["Webhooks"], "webhooks:manage", {
        description: "Replays every failed delivery of the last 7 days, for example after an outage on your side.",
        parameters: [idParam("Webhook id")],
        responses: { "202": ok("Queued", obj({ replayed: int() })), ...errors(401, 403, 404, 409) },
      }),
    },
    "/suppressions": {
      get: op("List suppressed addresses", ["Suppressions"], "suppressions:manage", {
        responses: { "200": ok("Suppressions", obj({ data: arr(ref("Suppression")) })), ...errors(401, 403) },
      }),
      post: op("Suppress an address", ["Suppressions"], "suppressions:manage", {
        requestBody: body(obj({ email: str(undefined, { format: "email" }), reason: str(undefined, { enum: ["HARD_BOUNCE", "SPAM_COMPLAINT", "UNSUBSCRIBE", "MANUAL"] }) }, ["email"])),
        responses: { "201": ok("Suppressed", ref("Suppression")), ...errors(400, 401, 403, 409) },
      }),
    },
    "/suppressions/{id}": {
      delete: op("Remove a suppression", ["Suppressions"], "suppressions:manage", {
        description: "Allows sending to the address again. Only do this when you know the address is valid again.",
        parameters: [idParam("Suppression id")],
        responses: { "200": ok("Removed", obj({ success: bool(), message: str() })), ...errors(401, 403, 404) },
      }),
    },
    "/api-keys": {
      get: op("List API keys", ["API keys"], "api_keys:manage", {
        responses: { "200": ok("Keys (without secrets)", obj({ data: arr(ref("ApiKey")) })), ...errors(401, 403) },
      }),
      post: op("Create an API key", ["API keys"], "api_keys:manage", {
        description: "The `token` is returned once. A key cannot grant scopes it does not hold.",
        requestBody: body(obj({ name: str(), scopes: arr(str(undefined, { enum: [...API_SCOPES] })), expires_at: dateTime() }, ["name"]), {
          name: "Billing service",
          scopes: ["emails:send"],
        }),
        responses: { "201": ok("Created", { allOf: [ref("ApiKey"), obj({ token: str() })] }), ...errors(400, 401, 403) },
      }),
    },
    "/api-keys/{id}": {
      delete: op("Revoke an API key", ["API keys"], "api_keys:manage", {
        parameters: [idParam("API key id")],
        responses: { "200": ok("Revoked", { type: "object" }), ...errors(401, 403, 404) },
      }),
    },
    "/stats": {
      get: op("Lifetime metrics", ["Stats"], "stats:read", {
        responses: { "200": ok("Metrics and the 10 latest emails", obj({ metrics: { type: "object" }, recentEmails: arr({ type: "object" }) })), ...errors(401, 403) },
      }),
    },
    "/stats/timeseries": {
      get: op("Daily metrics", ["Stats"], "stats:read", {
        description: "Emails per UTC day reaching each outcome. Opens and clicks count unique emails.",
        parameters: [query("days", int(undefined, { minimum: 1, maximum: 90, default: 30 }), "Period."), query("domain", str(), "Sending domain.")],
        responses: {
          "200": ok("Series", obj({
            days: int(),
            start: dateTime(),
            data: arr(obj({ date: str(undefined, { format: "date" }), sent: int(), delivered: int(), deferred: int(), bounced: int(), complained: int(), failed: int(), opened: int(), clicked: int() })),
          })),
          ...errors(400, 401, 403),
        },
      }),
    },
    "/stats/domains": {
      get: op("Metrics per domain", ["Stats"], "stats:read", {
        parameters: [query("days", int(undefined, { minimum: 1, maximum: 90, default: 30 }), "Period.")],
        responses: { "200": ok("Per domain", obj({ days: int(), data: arr({ type: "object" }) })), ...errors(400, 401, 403) },
      }),
    },
    "/usage": {
      get: op("Usage and limits", ["Usage and plans"], "stats:read", {
        description:
          "Recipients accepted this month (to, cc and bcc each count once) against the plan's allowance. Sends beyond the limits are refused with `429 daily_limit_exceeded` or `429 monthly_quota_exceeded`.",
        responses: { "200": ok("Usage", ref("Usage"), {
          period_start: "2026-10-01T00:00:00.000Z",
          period_end: "2026-11-01T00:00:00.000Z",
          emails_sent: 1250,
          emails_today: 84,
          monthly_limit: 50000,
          daily_limit: 5000,
          remaining: 148750,
          overage_emails: 0,
          plan: { plan: "pro", plan_name: "Pro", currency: "KES", interval: "month", price: 250000, monthly_emails: 50000, daily_emails: 5000, overage_price_per_1000: 12000, overage_limit: 100000, max_domains: 10, max_members: 10, log_retention_days: 30 },
        }), ...errors(401, 403) },
      }),
    },
    "/plans": {
      get: {
        summary: "List plans",
        tags: ["Usage and plans"],
        security: [],
        description: "The public price list. Amounts are in minor units (cents) of `currency`. No API key needed.",
        responses: { "200": ok("Plans", obj({ data: arr(ref("Plan")) })) },
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: { type: "http", scheme: "bearer", bearerFormat: "tred_live_...", description: "An API key from Console → API keys." },
    },
    responses: Object.fromEntries(
      [
        [400, "The request is malformed or fails validation."],
        [401, "Missing or invalid API key."],
        [403, "The key lacks the required scope, the sender is not allowed, the plan's limit is reached (`plan_limit_reached`), or sending is paused or suspended for the workspace."],
        [404, "Not found in this workspace."],
        [409, "Conflicts with the current state (e.g. canceling an email that is already sending)."],
        [422, "Understood but cannot be processed (e.g. suppressed recipient, unverified domain)."],
        [429, "Rate limit, sandbox limit or plan limit reached (`rate_limit_exceeded`, `sandbox_limit_reached`, `daily_limit_exceeded`, `monthly_quota_exceeded`)."],
      ].map(([code, description]) => [`Error${code}`, { description, content: json(ref("Error")) }]),
    ),
    schemas: {
      Error: obj({ statusCode: int(), error: str("Stable machine-readable code"), message: str("Human-readable explanation") }, ["statusCode", "error", "message"]),
      Address: str("`user@domain` or `Name <user@domain>`"),
      SendEmailRequest: obj(
        {
          from: str("Sender on a verified domain, e.g. `Dovepeak <billing@dovepeakdigital.com>`. Optional when the template has one."),
          to: { oneOf: [str(undefined, { format: "email" }), arr(str(undefined, { format: "email" }))], description: "Up to 50 addresses." },
          cc: { oneOf: [str(), arr(str())] },
          bcc: { oneOf: [str(), arr(str())] },
          reply_to: str(undefined, { format: "email" }),
          subject: str("Optional when using a template."),
          html: str(),
          text: str(),
          template: str("Template id or alias. Request fields override the template's."),
          variables: { type: "object", additionalProperties: true, description: "Values for the template's {{variables}}." },
          scheduled_at: dateTime("Send at this time (up to 30 days ahead). Omit to send now."),
          headers: { type: "object", additionalProperties: str(), description: "Custom headers. Standard and `X-TredMail-*` headers are reserved." },
          tags: arr(obj({ name: str(), value: str() }, ["name", "value"]), "Up to 50. A `category` tag groups Gmail Postmaster statistics."),
          attachments: arr(obj({ filename: str(), content: str("Base64"), content_type: str() }, ["filename", "content"]), "Up to 20; total request size 10 MB."),
          track_opens: bool("Default true."),
          track_clicks: bool("Default true."),
        },
        ["to"],
      ),
      EmailStatus: str(undefined, { enum: ["scheduled", "canceled", "queued", "sending", "sent", "delivered", "failed", "bounced", "complained"] }),
      EmailAccepted: obj(
        { id: str(), from: str(), to: arr(str()), status: str(undefined, { enum: ["queued", "scheduled"] }), scheduled_at: nullable(dateTime()), created_at: dateTime() },
        ["id", "status"],
      ),
      EmailSummary: obj({
        id: str(undefined, { example: exampleEmailId }),
        from: str(),
        to: arr(str()),
        subject: str(),
        status: ref("EmailStatus"),
        created_at: dateTime(),
        scheduled_at: nullable(dateTime()),
        delivered_at: nullable(dateTime()),
      }),
      Email: {
        allOf: [
          ref("EmailSummary"),
          obj({
            domain: str(),
            cc: arr(str()),
            bcc: arr(str()),
            reply_to: nullable(str()),
            html: nullable(str("Erased after the retention period (30 days by default).")),
            text: nullable(str()),
            tags: arr({ type: "object" }),
            template: nullable(obj({ id: str(), alias: str() })),
            attachments: arr(obj({ filename: str(), content_type: nullable(str()), size: int() })),
            smtp_response: nullable(str()),
            events: arr(ref("EmailEvent")),
          }),
        ],
      },
      EmailEvent: obj({
        id: str(),
        type: str(undefined, { enum: ["scheduled", "canceled", "queued", "sent", "deferred", "failed", "delivered", "opened", "clicked", "bounced", "complained"] }),
        timestamp: dateTime(),
        ip_address: nullable(str()),
        user_agent: nullable(str()),
        link_url: nullable(str()),
        details: { type: ["object", "null"], description: "Recipient, server response, bounce category and similar." },
      }),
      TemplateInput: obj(
        {
          name: str(),
          alias: str("Lowercase letters, digits, - and _. Used as `template` when sending.", { pattern: "^[a-z0-9][a-z0-9_-]*$" }),
          subject: str("May contain {{variables}}."),
          html: str("{{name}} is HTML-escaped; {{{name}}} inserts raw HTML; {{name|fallback}} sets a default."),
          text: str(),
          from: str("Default sender."),
          reply_to: str(),
        },
        ["name", "alias", "subject"],
      ),
      Template: obj({
        id: str(),
        name: str(),
        alias: str(),
        subject: str(),
        html: nullable(str()),
        text: nullable(str()),
        from: nullable(str()),
        reply_to: nullable(str()),
        variables: arr(str(), "Variables used in the subject and bodies."),
        created_at: dateTime(),
        updated_at: dateTime(),
      }),
      DnsRecord: obj({
        recordType: str(undefined, { enum: ["DKIM", "SPF", "DMARC", "RETURN_PATH"] }),
        type: str(undefined, { enum: ["TXT", "CNAME"] }),
        name: str("Fully qualified name"),
        host: str("Name relative to the domain, as DNS panels ask for it (`@` for the domain itself)"),
        expectedValue: str(),
        ttl: str(),
        verified: bool("Found at the last verification (GET /domains/{id} only)"),
      }),
      Domain: obj({
        id: str(),
        name: str(),
        status: str(undefined, { enum: ["pending", "verified", "failed"] }),
        region: str(),
        created_at: dateTime(),
        records: arr(ref("DnsRecord")),
      }),
      DmarcSummary: obj({
        domain: str(),
        days: int(),
        report_count: int(),
        message_count: int(),
        pass_count: int(),
        pass_rate: nullable({ type: "number" }),
        published_policy: nullable(str()),
        sources: arr(obj({ ip: str(), count: int(), pass: int(), fail: int(), reporters: arr(str()) })),
        reports: arr({ type: "object" }),
      }),
      WebhookEventType: str(undefined, { enum: ["*", ...WEBHOOK_EVENT_TYPES] }),
      Webhook: obj({
        id: str(),
        url: str(),
        subscribed_to: arr(ref("WebhookEventType")),
        is_active: bool(),
        total_deliveries: int(),
        failed_deliveries_7d: int(),
        created_at: dateTime(),
      }),
      WebhookDelivery: obj({
        id: str(),
        event: str(),
        message_id: str("Sent as the `webhook-id` header"),
        status: str(undefined, { enum: ["pending", "succeeded", "failed"] }),
        attempts: int(),
        status_code: nullable(int()),
        response: nullable(str("First 1,000 characters of your endpoint's response")),
        payload: { type: "object" },
        created_at: dateTime(),
        last_attempt_at: nullable(dateTime()),
        next_attempt_at: nullable(dateTime()),
      }),
      Suppression: obj({ id: str(), email: str(), reason: str(), diagnostic: nullable(str()), created_at: dateTime() }),
      Plan: obj({
        id: str(),
        name: str(),
        description: nullable(str()),
        currency: str("ISO 4217 code, e.g. KES"),
        price_monthly: int("Minor units (cents)"),
        price_yearly: nullable(int("Minor units; null when not offered yearly")),
        monthly_emails: int("Included recipients per month; 0 = unlimited"),
        daily_emails: int("0 = no daily cap"),
        overage_price_per_1000: nullable(int("Price per started 1,000 extra emails; null = sending stops at the allowance")),
        overage_limit: nullable(int("Most extra emails per month")),
        max_domains: int("0 = unlimited"),
        max_members: int("0 = unlimited"),
        log_retention_days: int(),
        features: arr(str()),
      }),
      Usage: obj({
        period_start: dateTime(),
        period_end: dateTime("When the monthly allowance resets"),
        emails_sent: int("Recipients accepted this period"),
        emails_today: int("Recipients accepted today (UTC)"),
        monthly_limit: int("0 = unlimited"),
        daily_limit: int("0 = no daily cap"),
        remaining: nullable(int("Recipients left before sending stops; null = no cap")),
        overage_emails: int("Recipients above the allowance, billed at the plan's overage price"),
        plan: { type: "object", description: "The workspace's plan with any custom terms applied" },
      }),
      ApiKey: obj({ id: str(), name: str(), key_prefix: str(), scopes: arr(str()), created_at: dateTime(), last_used_at: nullable(dateTime()), expires_at: nullable(dateTime()) }),
    },
  },
  webhooks: {
    emailEvent: {
      post: {
        summary: "Email event",
        description:
          "Sent to your endpoint for each subscribed event. Verify the `webhook-signature` header: base64 HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{body}` keyed with the base64 part of your `whsec_` secret, prefixed `v1,`. Reject timestamps older than 5 minutes. Respond 2xx within 10 seconds; other responses are retried for about 27 hours.",
        parameters: [
          { name: "webhook-id", in: "header", required: true, schema: str() },
          { name: "webhook-timestamp", in: "header", required: true, schema: str() },
          { name: "webhook-signature", in: "header", required: true, schema: str() },
        ],
        requestBody: body(obj({ type: ref("WebhookEventType"), created_at: dateTime(), data: { type: "object" } }), {
          type: "email.delivered",
          created_at: "2026-10-20T11:48:08.000Z",
          data: { email_id: exampleEmailId, recipient: "customer@example.com", smtp_response: "250 2.0.0 OK" },
        }),
        responses: { "200": { description: "Received" } },
      },
    },
  },
} as const;

/** Paths served under /v1 that are intentionally not part of the public API reference. */
export const UNDOCUMENTED_V1_PREFIXES = [
  "/v1/openapi.json", // the spec itself
  "/v1/track/", // links inside emails
  "/v1/me", // console session endpoints below
  "/v1/members",
  "/v1/workspace",
  "/v1/invitations",
  "/v1/audit-logs",
  "/v1/onboarding/",
  "/v1/billing", // console billing (session only)
  "/v1/admin/", // staff back-office
  "/v1/payments/callbacks/", // payment gateway notifications
];
