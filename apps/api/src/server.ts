import { env } from "@tredmail/core/config/env";
import { prisma } from "@tredmail/db";
import { redisConnection } from "@tredmail/core/queue/redis";
import { buildServer } from "./app.js";

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
