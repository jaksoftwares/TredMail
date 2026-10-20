import Fastify, { type RouteOptions } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "@tredmail/core/config/env";
import { prisma } from "@tredmail/db";
import { redisConnection } from "@tredmail/core/queue/redis";
import { hashApiKey } from "@tredmail/core/security/api-keys";
import { authenticate, requireScope } from "./middleware/auth.js";
import { emailRoutes, sendBatch } from "./routes/emails.js";
import { domainRoutes } from "./routes/domains.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { statsRoutes } from "./routes/stats.js";
import { trackingRoutes } from "./routes/tracking.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { suppressionRoutes } from "./routes/suppressions.js";
import { templateRoutes } from "./routes/templates.js";
import { openApiRoutes } from "./routes/openapi.js";

import { bounceRoutes } from "./routes/bounces.js";
import { mtaRoutes } from "./routes/mta.js";
import { accountRoutes, invitationLookupRoute, workspaceRoutes } from "./routes/account.js";
import { authHandlerRoutes } from "./routes/auth-handler.js";

const VERSION = "1.3.0";

export interface BuildOptions {
  /** Called for every route as it is registered (used by the OpenAPI coverage test). */
  onRoute?: (route: RouteOptions) => void;
}

export async function buildServer(options: BuildOptions = {}) {
  const fastify = Fastify({
    logger: { level: env.LOG_LEVEL ?? (env.NODE_ENV === "development" ? "info" : env.NODE_ENV === "test" ? "silent" : "warn") },
    trustProxy: env.TRUST_PROXY,
    // Attachments travel base64 in the JSON body (20 files, 10 MB per request in total).
    bodyLimit: 10 * 1024 * 1024,
  });
  if (options.onRoute) fastify.addHook("onRoute", options.onRoute);

  // Accept `Content-Type: application/json` with an empty body (common on DELETE from fetch
  // wrappers) instead of rejecting it; malformed JSON is still a 400.
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("Request body is not valid JSON."), { statusCode: 400 }), undefined);
    }
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
      // Same error shape as every other TredMail error (the plugin's default differs)
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: "rate_limit_exceeded",
        message: `Too many requests: at most ${context.max} per minute. Retry in ${context.after}.`,
      }),
    });

    await api.register(emailRoutes, { prefix: "/v1/emails" });
    await api.register(domainRoutes, { prefix: "/v1/domains" });
    await api.register(apiKeyRoutes, { prefix: "/v1/api-keys" });
    await api.register(statsRoutes, { prefix: "/v1/stats" });
    await api.register(webhookRoutes, { prefix: "/v1/webhooks" });
    await api.register(suppressionRoutes, { prefix: "/v1/suppressions" });
    await api.register(templateRoutes, { prefix: "/v1/templates" });

    // Console accounts, workspaces, members and invitations
    await api.register(accountRoutes, { prefix: "/v1" });
    await api.register(workspaceRoutes, { prefix: "/v1" });
    await api.register(invitationLookupRoute, { prefix: "/v1" });

    // Documented path for batch sending (also served at /v1/emails/batch)
    api.post("/v1/batch", { preHandler: [authenticate, requireScope("emails:send")] }, sendBatch);
  });

  // Console identity (Better Auth applies its own, stricter rate limits)
  await fastify.register(authHandlerRoutes);

  // Public tracking routes: signed URLs, no API key, not counted against API limits.
  await fastify.register(trackingRoutes, { prefix: "/v1/track" });

  // Public API description (rendered by the console docs)
  await fastify.register(openApiRoutes);

  // Internal MTA callbacks, only when an internal token is configured.
  if (env.INTERNAL_API_TOKEN) {
    await fastify.register(bounceRoutes, { prefix: "/internal/bounces" });
    await fastify.register(mtaRoutes, { prefix: "/internal/mta" });
  }

  return fastify;
}

