/**
 * Per-IP limits for the public API, alongside the per-key rate limit:
 *  - failed authentication: after AUTH_FAILURE_LIMIT invalid API keys in a minute, the address
 *    gets 429 without a database lookup, so random keys cannot be used to hammer the database
 *    or to dodge the per-key limit (each fake key would otherwise get its own bucket);
 *  - a request ceiling per address and minute, above any single key's limit.
 * Both fail open: if Redis is unreachable, requests are not refused because of it.
 */

/** The Redis commands used (ioredis implements them; tests pass a small fake). */
export interface CounterStore {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

export const AUTH_FAILURE_LIMIT = 30;
const WINDOW_MS = 60_000;

const windowKey = (prefix: string, ip: string, window: number) => `${prefix}:${ip}:${window}`;
/** Milliseconds until the current one-minute window ends. */
export const retryAfterMs = (now = Date.now()) => WINDOW_MS - (now % WINDOW_MS);

/**
 * Requests in the last minute, estimated from this minute's count and the previous minute's,
 * weighted by how much of it is still inside the last 60 seconds (a sliding window). Fixed
 * one-minute windows would let twice the limit through around each minute boundary.
 */
async function slidingCount(store: CounterStore, prefix: string, ip: string, now: number): Promise<number> {
  const window = Math.floor(now / WINDOW_MS);
  const elapsed = (now % WINDOW_MS) / WINDOW_MS;
  const [previous, current] = await Promise.all([store.get(windowKey(prefix, ip, window - 1)), store.get(windowKey(prefix, ip, window))]);
  return Number(previous ?? 0) * (1 - elapsed) + Number(current ?? 0);
}

async function bump(store: CounterStore, prefix: string, ip: string, now: number): Promise<void> {
  const key = windowKey(prefix, ip, Math.floor(now / WINDOW_MS));
  if ((await store.incr(key)) === 1) await store.pexpire(key, WINDOW_MS * 2);
}

export async function tooManyAuthFailures(store: CounterStore, ip: string, now = Date.now()): Promise<boolean> {
  try {
    return (await slidingCount(store, "tredmail:auth-fail", ip, now)) >= AUTH_FAILURE_LIMIT;
  } catch {
    return false;
  }
}

export async function recordAuthFailure(store: CounterStore, ip: string, now = Date.now()): Promise<void> {
  await bump(store, "tredmail:auth-fail", ip, now).catch(() => undefined);
}

/** Counts one request from `ip`; false once it is over `max` in the last minute. */
export async function withinIpLimit(store: CounterStore, ip: string, max: number, now = Date.now()): Promise<boolean> {
  try {
    await bump(store, "tredmail:ip-rl", ip, now);
    return (await slidingCount(store, "tredmail:ip-rl", ip, now)) <= max;
  } catch {
    return true;
  }
}
