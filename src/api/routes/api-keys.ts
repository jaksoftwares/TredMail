import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { generateApiKey } from "../../security/api-keys.js";
import { API_SCOPES, DEFAULT_KEY_SCOPES, canGrantScopes } from "../../security/scopes.js";
import { authenticateApiKey, requireScope } from "../middleware/auth.js";

const createKeySchema = z.object({
  name: z.string().trim().min(1).max(50),
  scopes: z.array(z.enum(API_SCOPES)).min(1).optional().default(DEFAULT_KEY_SCOPES),
  expires_at: z.string().datetime().optional(),
});

export async function apiKeyRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateApiKey);
  fastify.addHook("preHandler", requireScope("api_keys:manage"));

  // GET /v1/api-keys - List API keys (never returns secrets)
  fastify.get("/", async (request, reply) => {
    const keys = await prisma.apiKey.findMany({
      where: { organizationId: request.organization!.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    return reply.status(200).send({ data: keys });
  });

  // POST /v1/api-keys - Create an API key. The plaintext token is returned once.
  fastify.post("/", async (request, reply) => {
    const parseResult = createKeySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "Invalid API key request.",
        details: parseResult.error.errors,
      });
    }

    const { name, scopes, expires_at } = parseResult.data;

    if (!canGrantScopes(request.apiKey!.scopes, scopes)) {
      return reply.status(403).send({
        statusCode: 403,
        error: "insufficient_scope",
        message: "A key cannot create another key with scopes it does not hold.",
      });
    }

    const expiresAt = expires_at ? new Date(expires_at) : null;
    if (expiresAt && expiresAt <= new Date()) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "'expires_at' must be in the future.",
      });
    }

    const key = generateApiKey(true);
    const apiKey = await prisma.apiKey.create({
      data: {
        organizationId: request.organization!.id,
        name,
        keyPrefix: key.keyPrefix,
        keyHash: key.keyHash,
        scopes,
        expiresAt,
      },
    });

    return reply.status(201).send({
      id: apiKey.id,
      name: apiKey.name,
      token: key.plaintextKey,
      scopes: apiKey.scopes,
      expires_at: apiKey.expiresAt?.toISOString() ?? null,
      created_at: apiKey.createdAt.toISOString(),
    });
  });

  // DELETE /v1/api-keys/:id - Revoke an API key (kept for audit, unusable immediately)
  fastify.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const key = await prisma.apiKey.findFirst({
      where: { id: request.params.id, organizationId: request.organization!.id, revokedAt: null },
    });

    if (!key) {
      return reply.status(404).send({ statusCode: 404, error: "not_found", message: "API key not found." });
    }

    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });

    return reply.status(200).send({ success: true, message: "API key revoked." });
  });
}
