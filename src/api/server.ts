import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "../config/env.js";
import { emailRoutes } from "./routes/emails.js";
import { domainRoutes } from "./routes/domains.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { statsRoutes } from "./routes/stats.js";
import { trackingRoutes } from "./routes/tracking.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { suppressionRoutes } from "./routes/suppressions.js";
import { bounceRoutes } from "./routes/bounces.js";

const fastify = Fastify({
  logger: {
    level: env.NODE_ENV === "development" ? "info" : "warn",
  },
});

async function main() {
  // 1. Enable CORS for Developer Console and client SDKs
  await fastify.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  });

  // 2. Register global rate limiter (100 requests per second per IP by default)
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  // 3. Health check endpoint
  fastify.get("/health", async () => {
    return {
      status: "healthy",
      service: "tredmail-api",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
    };
  });

  // 4. Register API Routes under /v1
  await fastify.register(emailRoutes, { prefix: "/v1/emails" });
  await fastify.register(domainRoutes, { prefix: "/v1/domains" });
  await fastify.register(apiKeyRoutes, { prefix: "/v1/api-keys" });
  await fastify.register(statsRoutes, { prefix: "/v1/stats" });
  await fastify.register(webhookRoutes, { prefix: "/v1/webhooks" });
  await fastify.register(suppressionRoutes, { prefix: "/v1/suppressions" });
  await fastify.register(bounceRoutes, { prefix: "/v1/bounces" });

  // 5. Register Public Tracking Routes (No Auth required)
  await fastify.register(trackingRoutes, { prefix: "/v1/track" });

  // 6. Start listening
  try {
    await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
    console.log(`\n🚀 TredMail API Gateway is running on port ${env.PORT}`);
    console.log(`   Base URL: ${env.API_BASE_URL}`);
    console.log(`   Health Check: http://localhost:${env.PORT}/health\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main();
