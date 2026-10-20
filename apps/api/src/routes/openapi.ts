import type { FastifyInstance } from "fastify";
import { openApiSpec } from "@tredmail/core/openapi/spec";

/** GET /v1/openapi.json - the public API description, no key needed. */
export async function openApiRoutes(fastify: FastifyInstance) {
  fastify.get("/v1/openapi.json", async (_request, reply) =>
    reply.header("Cache-Control", "public, max-age=300").header("Access-Control-Allow-Origin", "*").send(openApiSpec),
  );
}
