import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

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
    CONSOLE_URL: z.string().url().default("http://localhost:3001"),
    // Comma-separated list of browser origins allowed to call the API. Defaults to CONSOLE_URL.
    CORS_ORIGINS: z.string().optional(),

    // 32-byte key, hex encoded (openssl rand -hex 32). Encrypts DKIM private keys and
    // derives the tracking-link signing key. No default: a missing key must stop the process.
    TREDMAIL_MASTER_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (openssl rand -hex 32)"),

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

    PRIMARY_DOMAIN: z.string().default("tredmail.dovepeak.com"),
    TRACKING_DOMAIN: z.string().default("track.tredmail.dovepeak.com"),
    BOUNCE_DOMAIN: z.string().default("bounces.tredmail.dovepeak.com"),
    DEFAULT_DKIM_SELECTOR: z.string().default("tredmail"),
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
    if (!cfg.INTERNAL_API_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["INTERNAL_API_TOKEN"],
        message: "is required in production",
      });
    }
    if (!cfg.TRACKING_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TRACKING_BASE_URL"],
        message: "is required in production (e.g. https://track.tredmail.dovepeak.com/v1/track)",
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
  });

export type Env = z.infer<typeof envSchema> & {
  TRACKING_BASE_URL: string;
  CORS_ORIGIN_LIST: string[];
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
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

export const env = loadEnv();
