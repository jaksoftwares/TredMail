import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { generateApiKey } from "../../security/api-keys.js";
import { authenticateApiKey } from "../middleware/auth.js";

const createKeySchema = z.object({
  name: z.string().min(1).max(50),
  scopes: z.array(z.string()).optional().default(["email:send", "domains:read"]),
});

export async function apiKeyRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateApiKey);

  // -------------------------------------------------------------
  // GET /v1/api-keys - List API Keys
  // -------------------------------------------------------------
  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const keys = await prisma.apiKey.findMany({
      where: { organizationId: request.organization!.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return reply.status(200).send({ data: keys });
  });

  // -------------------------------------------------------------
  // POST /v1/api-keys - Create API Key
  // -------------------------------------------------------------
  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = createKeySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "Invalid API key request.",
        details: parseResult.error.errors,
      });
    }

    const { name, scopes } = parseResult.data;
    const key = generateApiKey(true);

    const apiKey = await prisma.apiKey.create({
      data: {
        organizationId: request.organization!.id,
        name,
        keyPrefix: key.keyPrefix,
        keyHash: key.keyHash,
        scopes,
      },
    });

    return reply.status(201).send({
      id: apiKey.id,
      name: apiKey.name,
      token: key.plaintextKey, // Return plaintext ONCE!
      scopes: apiKey.scopes,
      created_at: apiKey.createdAt.toISOString(),
    });
  });

  // -------------------------------------------------------------
  // DELETE /v1/api-keys/:id - Revoke API Key
  // -------------------------------------------------------------
  fastify.delete("/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const key = await prisma.apiKey.findFirst({
      where: { id, organizationId: request.organization!.id },
    });

    if (!key) {
      return reply.status(404).send({
        statusCode: 404,
        error: "not_found",
        message: "API key not found.",
      });
    }

    await prisma.apiKey.delete({ where: { id } });

    return reply.status(200).send({ success: true, message: "API key revoked." });
  });
}
