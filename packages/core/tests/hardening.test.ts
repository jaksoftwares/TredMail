import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/security/log-redaction.js";
import { AUTH_FAILURE_LIMIT, recordAuthFailure, tooManyAuthFailures, withinIpLimit, type CounterStore } from "../src/security/ip-limits.js";
import { createSafeLookup, UnsafeUrlError } from "../src/security/url-safety.js";
import { isSealedWebhookSecret, openWebhookSecret, sealWebhookSecret, signWebhookPayload } from "../src/webhooks/dispatcher.js";

/** In-memory stand-in for the Redis commands the limits use. */
function memoryStore(): CounterStore {
  const values = new Map<string, number>();
  return {
    get: async (key) => (values.has(key) ? String(values.get(key)) : null),
    incr: async (key) => {
      values.set(key, (values.get(key) ?? 0) + 1);
      return values.get(key)!;
    },
    pexpire: async () => 1,
  };
}

const failingStore: CounterStore = {
  get: async () => Promise.reject(new Error("redis down")),
  incr: async () => Promise.reject(new Error("redis down")),
  pexpire: async () => Promise.reject(new Error("redis down")),
};

describe("log redaction", () => {
  it("removes the secret token from payment callback URLs", () => {
    expect(redactUrl("/v1/payments/callbacks/mobile/stk/abc123def456")).toBe("/v1/payments/callbacks/mobile/stk/[redacted]");
    expect(redactUrl("/v1/payments/callbacks/mobile/confirm/abc123?x=1")).toBe("/v1/payments/callbacks/mobile/confirm/[redacted]?x=1");
    expect(redactUrl("/v1/emails?limit=10")).toBe("/v1/emails?limit=10");
  });
});

describe("per-IP limits", () => {
  const now = Date.parse("2026-11-10T12:00:30Z");

  it("blocks an address after repeated invalid API keys, within the minute", async () => {
    const store = memoryStore();
    for (let i = 0; i < AUTH_FAILURE_LIMIT - 1; i++) await recordAuthFailure(store, "203.0.113.9", now);
    expect(await tooManyAuthFailures(store, "203.0.113.9", now)).toBe(false);
    await recordAuthFailure(store, "203.0.113.9", now);
    expect(await tooManyAuthFailures(store, "203.0.113.9", now)).toBe(true);
    expect(await tooManyAuthFailures(store, "198.51.100.1", now)).toBe(false);
    expect(await tooManyAuthFailures(store, "203.0.113.9", now + 60_000)).toBe(false);
  });

  it("caps requests per address and minute", async () => {
    const store = memoryStore();
    expect(await withinIpLimit(store, "203.0.113.9", 2, now)).toBe(true);
    expect(await withinIpLimit(store, "203.0.113.9", 2, now)).toBe(true);
    expect(await withinIpLimit(store, "203.0.113.9", 2, now)).toBe(false);
  });

  it("fails open when Redis is unreachable", async () => {
    expect(await tooManyAuthFailures(failingStore, "203.0.113.9")).toBe(false);
    expect(await withinIpLimit(failingStore, "203.0.113.9", 1)).toBe(true);
    await expect(recordAuthFailure(failingStore, "203.0.113.9")).resolves.toBeUndefined();
  });
});

describe("connect-time address check (DNS rebinding)", () => {
  const resolve = (lookup: ReturnType<typeof createSafeLookup>, all: boolean) =>
    new Promise<{ err: Error | null; address: unknown }>((done) => lookup("hooks.example.com", { all }, (err, address) => done({ err, address })));

  it("connects to the public address it checked", async () => {
    const lookup = createSafeLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    expect(await resolve(lookup, false)).toEqual({ err: null, address: "93.184.216.34" });
    expect((await resolve(lookup, true)).address).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses a name that resolves to a private address at connect time", async () => {
    // The check when the URL was saved passed; the second resolution (the rebinding) does not
    let calls = 0;
    const lookup = createSafeLookup(async () => (calls++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "169.254.169.254", family: 4 }]));
    await resolve(lookup, false);
    const { err } = await resolve(lookup, false);
    expect(err).toBeInstanceOf(UnsafeUrlError);
    const mixed = createSafeLookup(async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    expect((await resolve(mixed, true)).err).toBeInstanceOf(UnsafeUrlError);
  });
});

describe("webhook signing secrets at rest", () => {
  it("stores secrets encrypted and signs with the plain value", () => {
    const secret = "whsec_" + Buffer.from("x".repeat(24)).toString("base64");
    const sealed = sealWebhookSecret(secret);
    expect(sealed).not.toContain("whsec_");
    expect(isSealedWebhookSecret(sealed)).toBe(true);
    expect(openWebhookSecret(sealed)).toBe(secret);
    expect(signWebhookPayload(openWebhookSecret(sealed), "msg_1", 1, "{}")).toBe(signWebhookPayload(secret, "msg_1", 1, "{}"));
  });

  it("still accepts secrets stored before encryption", () => {
    const legacy = "whsec_" + Buffer.from("y".repeat(24)).toString("base64");
    expect(isSealedWebhookSecret(legacy)).toBe(false);
    expect(openWebhookSecret(legacy)).toBe(legacy);
  });
});

describe("per-IP limits across a minute boundary", () => {
  it("counts recent failures from the previous minute too", async () => {
    const store = memoryStore();
    const endOfMinute = Date.parse("2026-11-10T12:00:59Z");
    for (let i = 0; i < 20; i++) await recordAuthFailure(store, "203.0.113.9", endOfMinute);
    const startOfNext = Date.parse("2026-11-10T12:01:01Z");
    for (let i = 0; i < 12; i++) await recordAuthFailure(store, "203.0.113.9", startOfNext);
    // 20 failures two seconds ago plus 12 now: blocked, although neither minute alone reached 30
    expect(await tooManyAuthFailures(store, "203.0.113.9", startOfNext)).toBe(true);
    // A minute later the old failures no longer count
    expect(await tooManyAuthFailures(store, "203.0.113.9", Date.parse("2026-11-10T12:02:30Z"))).toBe(false);
  });
});
