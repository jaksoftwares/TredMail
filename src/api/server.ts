import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "../config/env.js";
import { prisma } from "../db/client.js";
import { redisConnection } from "../queue/redis.js";
import { hashApiKey } from "../security/api-keys.js";
import { authenticateApiKey, requireScope } from "./middleware/auth.js";
import { emailRoutes, sendBatch } from "./routes/emails.js";
import { domainRoutes } from "./routes/domains.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { statsRoutes } from "./routes/stats.js";
import { trackingRoutes } from "./routes/tracking.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { suppressionRoutes } from "./routes/suppressions.js";
import { bounceRoutes } from "./routes/bounces.js";

const VERSION = "1.1.0";

export async function buildServer() {
  const fastify = Fastify({
    logger: { level: env.LOG_LEVEL ?? (env.NODE_ENV === "development" ? "info" : "warn") },
    trustProxy: env.TRUST_PROXY,
    // Attachments travel base64 in the JSON body until object storage lands (roadmap Phase 3).
    bodyLimit: 10 * 1024 * 1024,
  });

  await fastify.register(cors, {
    origin: env.CORS_ORIGIN_LIST,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  });

  // Liveness: the process is up. Readiness: its dependencies answer.
  fastify.get("/health", async () => ({ status: "ok", service: "tredmail-api", version: VERSION }));
  fastify.get("/health/ready", async (_request, reply) => {
    const checks = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redisConnection.ping()]);
    const [database, redis] = checks.map((c) => (c.status === "fulfilled" ? "ok" : "down"));
    const ready = database === "ok" && redis === "ok";
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "degraded", database, redis });
  });

  // Authenticated API, rate limited per API key (per IP when no key is sent).
  await fastify.register(async (api) => {
    await api.register(rateLimit, {
      max: env.RATE_LIMIT_PER_MINUTE,
      timeWindow: "1 minute",
      redis: redisConnection,
      nameSpace: "tredmail-rl:",
      keyGenerator: (request) => {
        const auth = request.headers.authorization;
        return auth?.startsWith("Bearer ") ? `key:${hashApiKey(auth.substring(7))}` : `ip:${request.ip}`;
      },
    });

    await api.register(emailRoutes, { prefix: "/v1/emails" });
    await api.register(domainRoutes, { prefix: "/v1/domains" });
    await api.register(apiKeyRoutes, { prefix: "/v1/api-keys" });
    await api.register(statsRoutes, { prefix: "/v1/stats" });
    await api.register(webhookRoutes, { prefix: "/v1/webhooks" });
    await api.register(suppressionRoutes, { prefix: "/v1/suppressions" });

    // Documented path for batch sending (also served at /v1/emails/batch)
    api.post("/v1/batch", { preHandler: [authenticateApiKey, requireScope("emails:send")] }, sendBatch);
  });

  // Public tracking routes: signed URLs, no API key, not counted against API limits.
  await fastify.register(trackingRoutes, { prefix: "/v1/track" });

  // Internal MTA callbacks, only when an internal token is configured.
  if (env.INTERNAL_API_TOKEN) {
    await fastify.register(bounceRoutes, { prefix: "/internal/bounces" });
  }

  return fastify;
}

async function main() {
  const fastify = await buildServer();

  const shutdown = async (signal: string) => {
    fastify.log.info({ signal }, "shutting down");
    await fastify.close();
    await Promise.allSettled([prisma.$disconnect(), redisConnection.quit()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
    fastify.log.info(`TredMail API listening on port ${env.PORT} (base URL ${env.API_BASE_URL})`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main();
