import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

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
    expect(error).toMatch(/INTERNAL_API_TOKEN/);
    expect(error).toMatch(/TRACKING_BASE_URL/);
  });

  it("derives tracking URL and CORS origins in development", () => {
    const cfg = loadEnv({ ...base, API_BASE_URL: "http://localhost:3000/v1", CONSOLE_URL: "http://localhost:3001" });
    expect(cfg.TRACKING_BASE_URL).toBe("http://localhost:3000/v1/track");
    expect(cfg.CORS_ORIGIN_LIST).toEqual(["http://localhost:3001"]);
  });
});
