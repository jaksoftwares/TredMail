import type { Redis } from "ioredis";

/**
 * The worker records a heartbeat in Redis every minute; GET /health/worker reports it, so an
 * external uptime monitor notices a stopped or stuck worker (nothing else would: the API keeps
 * accepting mail that is then never sent).
 */
export const HEARTBEAT_KEY = "tredmail:heartbeat:worker";
export const HEARTBEAT_EVERY_MS = 60_000;
/** A heartbeat older than this means the worker is down. */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

export async function writeHeartbeat(redis: Redis, now = Date.now()) {
  await redis.set(HEARTBEAT_KEY, String(now), "EX", 24 * 3600);
}

export interface WorkerHealth {
  status: "ok" | "down";
  last_heartbeat: string | null;
  age_seconds: number | null;
}

export function workerHealth(value: string | null, now = Date.now()): WorkerHealth {
  const at = value ? Number(value) : NaN;
  if (!Number.isFinite(at)) return { status: "down", last_heartbeat: null, age_seconds: null };
  const age = Math.max(0, now - at);
  return {
    status: age <= HEARTBEAT_STALE_MS ? "ok" : "down",
    last_heartbeat: new Date(at).toISOString(),
    age_seconds: Math.round(age / 1000),
  };
}

export async function readWorkerHealth(redis: Redis, now = Date.now()): Promise<WorkerHealth> {
  return workerHealth(await redis.get(HEARTBEAT_KEY), now);
}
