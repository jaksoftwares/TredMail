import { Redis } from "ioredis";
import { env } from "../config/env.js";

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
