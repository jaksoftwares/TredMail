import { describe, expect, it } from "vitest";
import { nextDomainState, type DomainState } from "../src/dns/domain-check.js";
import { loadEnv } from "../src/config/env.js";

const NOW = new Date("2026-11-10T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

const state = (over: Partial<DomainState>): DomainState => ({
  status: "PENDING",
  createdAt: new Date(NOW.getTime() - 10 * MIN),
  failingSince: null,
  ...over,
});
const pass = { isFullyVerified: true, inconclusive: false };
const fail = { isFullyVerified: false, inconclusive: false };
const noAnswer = { isFullyVerified: false, inconclusive: true };
const inMs = (date: Date | null) => (date ? date.getTime() - NOW.getTime() : null);

describe("automatic domain checks", () => {
  it("verifies a pending domain as soon as its records pass, then re-checks daily", () => {
    const next = nextDomainState(state({}), pass, NOW);
    expect(next).toMatchObject({ status: "VERIFIED", change: "verified", failingSince: null });
    expect(inMs(next.nextCheckAt)).toBe(24 * HOUR);
  });

  it("checks a new pending domain every 5 minutes, then hourly, then daily", () => {
    expect(inMs(nextDomainState(state({}), fail, NOW).nextCheckAt)).toBe(5 * MIN);
    expect(inMs(nextDomainState(state({ createdAt: new Date(NOW.getTime() - 3 * HOUR) }), fail, NOW).nextCheckAt)).toBe(HOUR);
    expect(inMs(nextDomainState(state({ createdAt: new Date(NOW.getTime() - 80 * HOUR) }), fail, NOW).nextCheckAt)).toBe(24 * HOUR);
    expect(nextDomainState(state({}), fail, NOW)).toMatchObject({ status: "PENDING", change: null });
  });

  it("degrades a verified domain whose records fail, and keeps it sendable", () => {
    const next = nextDomainState(state({ status: "VERIFIED" }), fail, NOW);
    expect(next).toMatchObject({ status: "DEGRADED", change: "degraded", failingSince: NOW });
    expect(inMs(next.nextCheckAt)).toBe(HOUR);
  });

  it("fails a domain only after 72 hours of failing checks", () => {
    const since = new Date(NOW.getTime() - 71 * HOUR);
    expect(nextDomainState(state({ status: "DEGRADED", failingSince: since }), fail, NOW)).toMatchObject({ status: "DEGRADED", change: null });
    const old = new Date(NOW.getTime() - 72 * HOUR);
    expect(nextDomainState(state({ status: "DEGRADED", failingSince: old }), fail, NOW)).toMatchObject({ status: "FAILED", change: "failed" });
  });

  it("recovers a degraded or failed domain when its records pass again", () => {
    expect(nextDomainState(state({ status: "DEGRADED", failingSince: NOW }), pass, NOW)).toMatchObject({ status: "VERIFIED", change: "recovered", failingSince: null });
    expect(nextDomainState(state({ status: "FAILED", failingSince: NOW }), pass, NOW)).toMatchObject({ status: "VERIFIED", change: "recovered" });
    expect(nextDomainState(state({ status: "VERIFIED" }), pass, NOW).change).toBeNull();
  });

  it("changes nothing when DNS does not answer, and retries in 15 minutes", () => {
    const next = nextDomainState(state({ status: "VERIFIED" }), noAnswer, NOW);
    expect(next).toMatchObject({ status: "VERIFIED", change: null });
    expect(inMs(next.nextCheckAt)).toBe(15 * MIN);
  });

  it("never checks a suspended domain automatically", () => {
    expect(nextDomainState(state({ status: "SUSPENDED" }), pass, NOW)).toMatchObject({ status: "SUSPENDED", nextCheckAt: null, change: null });
  });

  it("runs automatically except in development, unless configured", () => {
    const base = { DATABASE_URL: "postgresql://x", TREDMAIL_MASTER_ENCRYPTION_KEY: "d".repeat(64) };
    expect(loadEnv({ ...base, NODE_ENV: "development" }).DOMAIN_AUTO_CHECKS).toBe(false);
    expect(loadEnv({ ...base, NODE_ENV: "test" }).DOMAIN_AUTO_CHECKS).toBe(true);
    expect(loadEnv({ ...base, NODE_ENV: "development", DOMAIN_AUTO_CHECKS: "true" }).DOMAIN_AUTO_CHECKS).toBe(true);
    expect(loadEnv({ ...base, NODE_ENV: "test", DOMAIN_AUTO_CHECKS: "false" }).DOMAIN_AUTO_CHECKS).toBe(false);
  });
});
