import type { Redis } from "ioredis";

/**
 * IP warm-up: mailbox providers trust a new sending IP gradually, so the daily volume sent
 * through our own mail server grows over about three weeks. Mail above the day's cap goes
 * through the fallback relay when one is configured, or waits for the next day.
 *
 * Sized for Dovepeak's volumes (about 100 a day today, about 3,000 later): day 1 already
 * covers today's traffic, and 3,000 a day is reached in the second week.
 */
export const WARMUP_SCHEDULE = [
  150, 150, 300, 300, 600, 600, 1000, 1000, 1500, 1500, 2000, 2000, 3000, 3000, 4500, 4500, 6000, 6000, 8000, 10000,
];

const DAY_MS = 86_400_000;

const utcDay = (date: Date) => date.toISOString().slice(0, 10);

/** Today's cap, or null when warm-up is off or finished. */
export function warmupCap(startDate: string | undefined, now = new Date()): number | null {
  if (!startDate) return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  const dayIndex = Math.floor((Date.parse(`${utcDay(now)}T00:00:00Z`) - start) / DAY_MS);
  if (dayIndex < 0) return WARMUP_SCHEDULE[0];
  return dayIndex < WARMUP_SCHEDULE.length ? WARMUP_SCHEDULE[dayIndex] : null;
}

/** Milliseconds until the next UTC midnight, when the next day's cap starts. */
export function msUntilNextUtcDay(now = new Date()): number {
  return Date.parse(`${utcDay(new Date(now.getTime() + DAY_MS))}T00:00:00Z`) - now.getTime();
}

/**
 * Reserves `count` messages of today's warm-up allowance. Returns false (and reserves nothing)
 * when the cap would be exceeded.
 */
export async function reserveWarmupSlots(redis: Redis, cap: number | null, count: number, now = new Date()): Promise<boolean> {
  if (cap === null) return true;
  const key = `tredmail:warmup:${utcDay(now)}`;
  const used = await redis.incrby(key, count);
  if (used === count) await redis.expire(key, 2 * 24 * 3600);
  if (used > cap) {
    await redis.decrby(key, count);
    return false;
  }
  return true;
}
