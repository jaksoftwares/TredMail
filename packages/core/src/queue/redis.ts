import { Redis } from "ioredis";
import { env } from "../config/env.js";

/** The longest a request waits on Redis before it falls back (fail open, or queue later). */
export const REDIS_REQUEST_TIMEOUT_MS = 2000;

/**
 * The worker's connection, used by BullMQ queues and workers, heartbeats and alerts. Commands
 * wait for Redis to come back rather than fail, because background jobs need that. Request
 * handlers use request-redis.ts instead.
 */
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisConnection.on("error", (err) => {
  console.error("❌ Redis connection error:", err);
});

redisConnection.on("connect", () => {
  console.log("⚡ Connected to Redis at", env.REDIS_URL);
});
