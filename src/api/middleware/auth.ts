import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../db/client.js";
import { hashApiKey } from "../../security/api-keys.js";

declare module "fastify" {
  interface FastifyRequest {
    organization?: {
      id: string;
      name: string;
      slug: string;
      isCommercial: boolean;
    };
    apiKey?: {
      id: string;
      name: string;
      scopes: string[];
    };
  }
}

/**
 * Fastify preHandler hook for verifying TredMail Bearer API keys.
 */
export async function authenticateApiKey(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: "Missing or invalid Authorization header. Expected 'Bearer tred_live_...'",
    });
  }

  const token = authHeader.substring(7).trim();
  const keyHash = hashApiKey(token);

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: { organization: true },
  });

  if (!apiKey) {
    return reply.status(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: "Invalid API key provided.",
    });
  }

  // Update lastUsedAt asynchronously
  prisma.apiKey
    .update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  // Attach context to request
  request.organization = {
    id: apiKey.organization.id,
    name: apiKey.organization.name,
    slug: apiKey.organization.slug,
    isCommercial: apiKey.organization.isCommercial,
  };

  request.apiKey = {
    id: apiKey.id,
    name: apiKey.name,
    scopes: apiKey.scopes,
  };
}
