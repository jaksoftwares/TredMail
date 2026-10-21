import dotenv from "dotenv";
import { z } from "zod";

// Apps run from their own folders in the monorepo; the shared .env lives at the repository root.
dotenv.config({ path: [".env", "../../.env"] });

// The sample key that shipped in early versions of .env.example. Never valid in production.
const KNOWN_SAMPLE_KEYS = new Set([
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
]);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),

    // Public URLs. API_BASE_URL is what customers call; TRACKING_BASE_URL is embedded in emails.
    API_BASE_URL: z.string().url().default("http://localhost:3000/v1"),
    TRACKING_BASE_URL: z.string().url().optional(),
    CONSOLE_URL: z.string().url().default("http://localhost:3010"),
    // Comma-separated list of browser origins allowed to call the API. Defaults to CONSOLE_URL.
    CORS_ORIGINS: z.string().optional(),

    // 32-byte key, hex encoded (openssl rand -hex 32). Encrypts DKIM private keys and
    // derives the tracking-link signing key. No default: a missing key must stop the process.
    TREDMAIL_MASTER_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (openssl rand -hex 32)"),

    // Signs and encrypts console sessions (Better Auth). Only the API needs it; the API
    // refuses to start without it. openssl rand -hex 32
    BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -hex 32)").optional(),
    // Optional Google sign-in; both must be set to enable it
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    // Emails per day a workspace may send from the shared sandbox sender before verifying a domain
    SANDBOX_DAILY_LIMIT: z.coerce.number().int().min(0).default(50),

    // Shared secret for internal-only endpoints (bounce ingestion from the MTA).
    // Unset = internal endpoints are disabled.
    INTERNAL_API_TOKEN: z.string().min(32).optional(),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default("redis://localhost:6389"),

    // Outbound SMTP target (Mailpit in development, the MTA in production)
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: z.coerce.number().int().positive().default(1035),
    SMTP_SECURE: z.preprocess((val) => val === "true" || val === true, z.boolean()).default(false),
    SMTP_USER: z.string().optional().default(""),
    SMTP_PASS: z.string().optional().default(""),
    // Only for local relays with self-signed certificates. Refused in production.
    SMTP_ALLOW_INVALID_CERTS: z.preprocess((val) => val === "true" || val === true, z.boolean()).default(false),

    // Lets developers point webhooks at http://localhost. Refused in production.
    WEBHOOK_ALLOW_PRIVATE_TARGETS: z.preprocess((val) => val === "true" || val === true, z.boolean()).default(false),
    // Set when the API runs behind a reverse proxy (Caddy) so request.ip is the client's address.
    TRUST_PROXY: z.preprocess((val) => val === "true" || val === true, z.boolean()).default(false),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),

    // TredMail's own sending domain: account emails come from no-reply@ and the sandbox
    // sender is onboarding@. It belongs to the platform workspace and must be DNS-verified.
    PRIMARY_DOMAIN: z.string().default("tredmail.dovepeakdigital.com"),
    TRACKING_DOMAIN: z.string().default("track.tredmail.dovepeakdigital.com"),
    BOUNCE_DOMAIN: z.string().default("bounces.tredmail.dovepeakdigital.com"),
    DEFAULT_DKIM_SELECTOR: z.string().default("tredmail"),

    // --- Delivery engine (KumoMTA) ---
    // Name the mail server announces (HELO) and its IP's PTR record points to.
    MTA_HOSTNAME: z.string().default("mta1.tredmail.dovepeakdigital.com"),
    // Where operational mail goes: alerts, and mail sent to postmaster@, abuse@, dmarc@ and
    // other addresses at PRIMARY_DOMAIN. Unset = alerts are only logged and inbound mail is dropped.
    OPS_EMAIL: z.string().email().optional(),
    // At most this many inbound messages are forwarded to OPS_EMAIL per day (spam protection).
    INBOUND_FORWARD_DAILY_LIMIT: z.coerce.number().int().min(0).default(200),
    // First day (YYYY-MM-DD, UTC) of IP warm-up. Unset = no warm-up cap.
    MTA_WARMUP_START: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date like 2026-11-01")
      .optional(),
    // Optional relay (another provider's SMTP) for mail above the day's warm-up cap.
    FALLBACK_SMTP_HOST: z.string().optional(),
    FALLBACK_SMTP_PORT: z.coerce.number().int().positive().default(587),
    FALLBACK_SMTP_SECURE: z.preprocess((val) => val === "true" || val === true, z.boolean()).default(false),
    FALLBACK_SMTP_USER: z.string().optional().default(""),
    FALLBACK_SMTP_PASS: z.string().optional().default(""),

    // Staging only: recipients matching this list (addresses, or @domain) are delivered for
    // real through STAGING_DELIVERY_SMTP_HOST (a KumoMTA); everything else stays in Mailpit.
    STAGING_DELIVERY_ALLOWLIST: z.string().optional(),
    STAGING_DELIVERY_SMTP_HOST: z.string().optional(),
    STAGING_DELIVERY_SMTP_PORT: z.coerce.number().int().positive().default(2525),

    // SMTP relay (apps/smtp-relay): applications send through TredMail with SMTP, the API key
    // as password. TLS files come from Caddy's certificates via the cert-sync service.
    SMTP_RELAY_HOSTNAME: z.string().default("smtp.tredmail.dovepeakdigital.com"),
    SMTP_RELAY_PORT: z.coerce.number().int().positive().default(587),
    SMTP_RELAY_TLS_PORT: z.coerce.number().int().positive().optional(), // implicit TLS, e.g. 465
    SMTP_RELAY_TLS_CERT: z.string().optional(),
    SMTP_RELAY_TLS_KEY: z.string().optional(),

    // Data retention: message bodies are erased after this many days, and emails with their
    // events are deleted after the second limit (13 months keeps a full year for reports).
    EMAIL_CONTENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    EMAIL_RECORD_RETENTION_DAYS: z.coerce.number().int().min(30).default(395),

    // --- Billing ---
    BILLING_CURRENCY: z.string().length(3).default("KES"),
    // Tax added to invoices, in percent (Kenyan VAT is 16). 0 = no tax line.
    BILLING_TAX_RATE: z.coerce.number().min(0).max(100).default(0),
    BILLING_TAX_LABEL: z.string().default("VAT"),
    // Dovepeak's tax registration (KRA PIN), printed on invoices
    BILLING_TAX_ID: z.string().optional(),
    // Days an unpaid renewal keeps the paid plan before the workspace moves to Free
    BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
    // Renewal invoices are issued this many days before the period ends
    BILLING_RENEWAL_NOTICE_DAYS: z.coerce.number().int().min(0).max(30).default(3),
    // Automatic payment requests (M-Pesa prompts) are only sent between 08:00 and 20:00 here
    BILLING_TIMEZONE: z.string().default("Africa/Nairobi"),
    // Shown on invoices and billing emails as the address for billing questions
    BILLING_SUPPORT_EMAIL: z.string().email().optional(),

    // --- M-Pesa (Safaricom Daraja). The gateway is enabled when the four credentials are set. ---
    MPESA_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    // Overrides the Daraja URL (the local simulator, `npm run payments:simulator`)
    MPESA_BASE_URL: z.string().url().optional(),
    MPESA_CONSUMER_KEY: z.string().optional(),
    MPESA_CONSUMER_SECRET: z.string().optional(),
    // Business short code used for M-Pesa Express (STK push) and its passkey
    MPESA_SHORTCODE: z.string().regex(/^\d{5,7}$/, "must be the 5 to 7 digit short code").optional(),
    MPESA_PASSKEY: z.string().optional(),
    // Paybill (CustomerPayBillOnline) or Till (CustomerBuyGoodsOnline)
    MPESA_TRANSACTION_TYPE: z.enum(["CustomerPayBillOnline", "CustomerBuyGoodsOnline"]).default("CustomerPayBillOnline"),
    // Till number receiving Buy Goods payments (defaults to MPESA_SHORTCODE)
    MPESA_TILL_NUMBER: z.string().regex(/^\d{5,7}$/).optional(),
    // Paybill number customers pay to by hand (Lipa na M-Pesa > Pay Bill). Defaults to
    // MPESA_SHORTCODE for Paybill accounts; unset for Till-only accounts.
    MPESA_PAYBILL_NUMBER: z.string().regex(/^\d{5,7}$/).optional(),
    // Public HTTPS base URL Safaricom calls back (defaults to the origin of API_BASE_URL)
    MPESA_CALLBACK_BASE_URL: z.string().url().optional(),
    // Confirm each successful payment notification with Daraja's query API before accepting it
    MPESA_VERIFY_CALLBACKS: z.preprocess((val) => val !== "false" && val !== false, z.boolean()).default(true),
    // Optional comma-separated list of IP addresses allowed to send payment notifications
    MPESA_ALLOWED_IPS: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== "production") return;

    if (KNOWN_SAMPLE_KEYS.has(cfg.TREDMAIL_MASTER_ENCRYPTION_KEY.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TREDMAIL_MASTER_ENCRYPTION_KEY"],
        message: "is the public sample key; generate a new one with `openssl rand -hex 32`",
      });
    }
    if (!cfg.TRACKING_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TRACKING_BASE_URL"],
        message: "is required in production (e.g. https://track.tredmail.dovepeakdigital.com/v1/track)",
      });
    }
    if (cfg.WEBHOOK_ALLOW_PRIVATE_TARGETS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WEBHOOK_ALLOW_PRIVATE_TARGETS"],
        message: "must not be enabled in production",
      });
    }
    if (cfg.SMTP_ALLOW_INVALID_CERTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SMTP_ALLOW_INVALID_CERTS"],
        message: "must not be enabled in production",
      });
    }
    if (cfg.MPESA_BASE_URL && /localhost|127\.0\.0\.1/.test(cfg.MPESA_BASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MPESA_BASE_URL"],
        message: "points at the local simulator; remove it in production",
      });
    }
    const callbackBase = cfg.MPESA_CALLBACK_BASE_URL ?? cfg.API_BASE_URL;
    if (cfg.MPESA_CONSUMER_KEY && !callbackBase.startsWith("https://")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MPESA_CALLBACK_BASE_URL"],
        message: "must be an https:// URL in production (Safaricom refuses plain HTTP callbacks)",
      });
    }
  });

/** Workspace that owns TredMail's own sending domain. Created by the seed. */
export const PLATFORM_ORG_SLUG = "tredmail-platform";

export type Env = z.infer<typeof envSchema> & {
  TRACKING_BASE_URL: string;
  CORS_ORIGIN_LIST: string[];
};

/**
 * Accepts the common Daraja variable names (MPESA_ENV, MPESA_PARTY_B, MPESA_CALLBACK_URL)
 * alongside TredMail's, and treats empty or placeholder M-Pesa values as unset.
 */
function normalizeMpesa(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(out)) {
    if (!key.startsWith("MPESA_")) continue;
    const value = out[key]?.trim();
    out[key] = value ? value : undefined;
  }
  out.MPESA_ENVIRONMENT ??= out.MPESA_ENV;
  if (out.MPESA_PARTY_B) {
    if (out.MPESA_TRANSACTION_TYPE === "CustomerBuyGoodsOnline") out.MPESA_TILL_NUMBER ??= out.MPESA_PARTY_B;
    else out.MPESA_PAYBILL_NUMBER ??= out.MPESA_PARTY_B;
  }
  if (!out.MPESA_CALLBACK_BASE_URL && out.MPESA_CALLBACK_URL) {
    try {
      // Only the origin is used: TredMail builds its own callback paths under it
      out.MPESA_CALLBACK_BASE_URL = new URL(out.MPESA_CALLBACK_URL).origin;
    } catch {
      // not a URL yet ("to be confirmed"): fall back to API_BASE_URL
    }
  }
  return out;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(normalizeMpesa(source));
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"} ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid TredMail configuration:\n${problems}`);
  }

  const cfg = parsed.data;
  return {
    ...cfg,
    TRACKING_BASE_URL: (cfg.TRACKING_BASE_URL ?? `${cfg.API_BASE_URL}/track`).replace(/\/+$/, ""),
    CORS_ORIGIN_LIST: (cfg.CORS_ORIGINS ?? cfg.CONSOLE_URL)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

/**
 * Secrets only the API process uses. The worker never receives them, so they are checked
 * when the API starts rather than in the shared schema.
 */
export function assertApiSecrets(cfg: Env): void {
  const missing: string[] = [];
  if (!cfg.BETTER_AUTH_SECRET) missing.push("BETTER_AUTH_SECRET is required to run the API");
  if (cfg.NODE_ENV === "production" && !cfg.INTERNAL_API_TOKEN) missing.push("INTERNAL_API_TOKEN is required in production");
  const mpesa = [cfg.MPESA_CONSUMER_KEY, cfg.MPESA_CONSUMER_SECRET, cfg.MPESA_SHORTCODE, cfg.MPESA_PASSKEY];
  if (mpesa.some(Boolean) && !mpesa.every(Boolean)) {
    missing.push("M-Pesa needs all of MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE and MPESA_PASSKEY");
  }
  if (missing.length > 0) {
    throw new Error(`Invalid TredMail API configuration:\n${missing.map((m) => `  - ${m}`).join("\n")}`);
  }
}

export const env = loadEnv();
