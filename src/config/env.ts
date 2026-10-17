import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  API_BASE_URL: z.string().default("http://localhost:3000/v1"),
  CONSOLE_URL: z.string().default("http://localhost:3001"),

  // Master Secret for AES-256-GCM encryption of private keys (must be 32 bytes / 64 hex chars)
  TREDMAIL_MASTER_ENCRYPTION_KEY: z.string().min(32).default("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),

  // Database & Redis
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6389"),

  // Outbound SMTP target (Mailpit in dev, Postal/KumoMTA in prod)
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1035),
  SMTP_SECURE: z.preprocess((val) => val === "true" || val === true, z.boolean()).default(false),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),

  // Default domains
  PRIMARY_DOMAIN: z.string().default("tredmail.dovepeak.com"),
  TRACKING_DOMAIN: z.string().default("track.tredmail.dovepeak.com"),
  BOUNCE_DOMAIN: z.string().default("bounces.tredmail.dovepeak.com"),
  DEFAULT_DKIM_SELECTOR: z.string().default("tredmail"),
});

export const env = envSchema.parse(process.env);
