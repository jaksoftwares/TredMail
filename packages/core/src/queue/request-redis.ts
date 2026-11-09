import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * Redis connection for request handlers (the API and the SMTP relay): rate limits, auth-failure
 * counters, health checks. Unlike the worker's connection (redis.ts), which waits for Redis to
 * come back because background jobs need it to, this one fails at once while Redis is down, so
 * each caller can fall back (fail open, or queue later) instead of hanging the request. It still
 * reconnects by itself and works again as soon as Redis is back.
 */
export const redisRequests = new Redis(env.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisRequests.on("error", (err) => {
  console.error("❌ Redis (request connection) error:", err.message);
});
