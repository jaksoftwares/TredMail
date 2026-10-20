import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";
import crypto from "crypto";
import { prisma } from "@tredmail/db";
import { hashApiKey } from "@tredmail/core/security/api-keys";
import { hasScope, type ApiScope } from "@tredmail/core/security/scopes";
import { env } from "@tredmail/core/config/env";

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

function unauthorized(reply: FastifyReply, message: string) {
  return reply.status(401).send({ statusCode: 401, error: "unauthorized", message });
}

/**
 * Fastify preHandler hook for verifying TredMail Bearer API keys.
 */
export async function authenticateApiKey(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return unauthorized(reply, "Missing or invalid Authorization header. Expected 'Bearer tred_live_...'.");
  }

  const token = authHeader.substring(7).trim();
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(token) },
    include: { organization: true },
  });

  if (!apiKey || apiKey.revokedAt) {
    return unauthorized(reply, "Invalid API key provided.");
  }

  if (apiKey.expiresAt && apiKey.expiresAt <= new Date()) {
    return unauthorized(reply, "This API key has expired.");
  }

  prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => request.log.warn({ err }, "failed to update api key lastUsedAt"));

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

/**
 * Route-level guard: the authenticated key must hold `scope` (or full_access).
 * Use after authenticateApiKey.
 */
export function requireScope(scope: ApiScope): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.apiKey || !hasScope(request.apiKey.scopes, scope)) {
      return reply.status(403).send({
        statusCode: 403,
        error: "insufficient_scope",
        message: `This API key is missing the '${scope}' scope.`,
      });
    }
  };
}

/**
 * Guard for internal endpoints (MTA callbacks). Requires INTERNAL_API_TOKEN.
 */
export async function authenticateInternal(request: FastifyRequest, reply: FastifyReply) {
  const expected = env.INTERNAL_API_TOKEN;
  const header = request.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.substring(7).trim() : "";

  const expectedBuf = Buffer.from(expected ?? "");
  const givenBuf = Buffer.from(given);
  const valid =
    !!expected && expectedBuf.length === givenBuf.length && crypto.timingSafeEqual(expectedBuf, givenBuf);

  if (!valid) {
    return reply.status(401).send({ statusCode: 401, error: "unauthorized", message: "Invalid internal token." });
  }
}
