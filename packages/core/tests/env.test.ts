import { describe, expect, it } from "vitest";
import { assertApiSecrets, loadEnv } from "../src/config/env.js";

const base = {
  DATABASE_URL: "postgresql://x",
  TREDMAIL_MASTER_ENCRYPTION_KEY: "d".repeat(64),
  BETTER_AUTH_SECRET: "s".repeat(64),
};

function configError(source: NodeJS.ProcessEnv): string {
  try {
    loadEnv(source);
    return "";
  } catch (err) {
    return String(err);
  }
}

describe("loadEnv", () => {
  it("requires the master key", () => {
    expect(configError({ DATABASE_URL: "postgresql://x" })).toMatch(/TREDMAIL_MASTER_ENCRYPTION_KEY/);
  });

  it("refuses the public sample key and missing secrets in production", () => {
    const error = configError({
      ...base,
      NODE_ENV: "production",
      TREDMAIL_MASTER_ENCRYPTION_KEY: "0123456789abcdef".repeat(4), // gitleaks:allow (public sample key under test)
    });
    expect(error).toMatch(/public sample key/);
    expect(error).toMatch(/TRACKING_BASE_URL/);
  });

  it("lets the worker start without API-only secrets, but not the API", () => {
    const cfg = loadEnv({
      DATABASE_URL: "postgresql://x",
      TREDMAIL_MASTER_ENCRYPTION_KEY: "d".repeat(64),
      NODE_ENV: "production",
      TRACKING_BASE_URL: "https://track.example.com/v1/track",
    });
    expect(() => assertApiSecrets(cfg)).toThrow(/BETTER_AUTH_SECRET[\s\S]*INTERNAL_API_TOKEN/);
    expect(() => assertApiSecrets({ ...cfg, BETTER_AUTH_SECRET: "s".repeat(64), INTERNAL_API_TOKEN: "t".repeat(64) })).not.toThrow();
  });

  it("requires the Safaricom IP allowlist with live M-Pesa", () => {
    const live = {
      ...base,
      NODE_ENV: "production",
      TRACKING_BASE_URL: "https://track.example.com/v1/track",
      API_BASE_URL: "https://api.example.com/v1",
      MPESA_ENVIRONMENT: "production",
      MPESA_CONSUMER_KEY: "key",
    };
    expect(configError(live)).toMatch(/MPESA_ALLOWED_IPS is required with live M-Pesa/);
    expect(configError({ ...live, MPESA_ALLOWED_IPS: "196.201.214.200, 196.201.214.206" })).toBe("");
    // The Daraja sandbox (staging) does not need it
    expect(configError({ ...live, MPESA_ENVIRONMENT: "sandbox" })).toBe("");
  });

  it("derives tracking URL and CORS origins in development", () => {
    const cfg = loadEnv({ ...base, API_BASE_URL: "http://localhost:3000/v1", CONSOLE_URL: "http://localhost:3001" });
    expect(cfg.TRACKING_BASE_URL).toBe("http://localhost:3000/v1/track");
    expect(cfg.CORS_ORIGIN_LIST).toEqual(["http://localhost:3001"]);
  });

  it("treats blank optional values from docker-compose as unset", () => {
    const cfg = loadEnv({
      ...base,
      OPS_EMAIL: "",
      BILLING_SUPPORT_EMAIL: "",
      MTA_WARMUP_START: "",
    });
    expect(cfg.OPS_EMAIL).toBeUndefined();
    expect(cfg.BILLING_SUPPORT_EMAIL).toBeUndefined();
    expect(cfg.MTA_WARMUP_START).toBeUndefined();
  });

  it("treats any blank variable from a copied .env.example as unset", () => {
    expect(configError({ ...base, INTERNAL_API_TOKEN: "", SMTP_RELAY_TLS_PORT: "", SMTP_RELAY_TLS_CERT: "", MPESA_CONSUMER_KEY: "" })).toBe("");
  });

  it("still rejects malformed values for those fields", () => {
    expect(configError({ ...base, OPS_EMAIL: "not-an-email" })).toMatch(/OPS_EMAIL/);
    expect(configError({ ...base, MTA_WARMUP_START: "20-11-2026" })).toMatch(/MTA_WARMUP_START/);
  });

  it("allows skipping STARTTLS in production only for the internal kumomta host", () => {
    const prod = {
      ...base,
      NODE_ENV: "production",
      TRACKING_BASE_URL: "https://track.example.com/v1/track",
      SMTP_SKIP_STARTTLS: "true",
    };
    expect(configError({ ...prod, SMTP_HOST: "kumomta" })).toBe("");
    expect(configError({ ...prod, SMTP_HOST: "smtp.example.com" })).toMatch(/SMTP_SKIP_STARTTLS is only allowed/);
  });
});
