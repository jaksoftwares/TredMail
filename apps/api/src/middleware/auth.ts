import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";
import crypto from "crypto";
import { fromNodeHeaders } from "better-auth/node";
import { prisma } from "@tredmail/db";
import { hashApiKey } from "@tredmail/core/security/api-keys";
import { hasScope, type ApiScope } from "@tredmail/core/security/scopes";
import { ROLE_SCOPES, canManageMembers, type WorkspaceRole } from "@tredmail/core/security/roles";
import { env } from "@tredmail/core/config/env";
import { auth } from "../auth.js";

/** Header the console sends to say which workspace a signed-in member is acting in. */
export const WORKSPACE_HEADER = "x-tredmail-workspace";

export type Principal =
  | { kind: "api_key"; apiKeyId: string; name: string; scopes: string[] }
  | { kind: "user"; userId: string; email: string; role: WorkspaceRole; scopes: string[] };

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    organization?: {
      id: string;
      name: string;
      slug: string;
      isCommercial: boolean;
    };
    principal?: Principal;
    sessionUser?: SessionUser;
  }
}

function fail(reply: FastifyReply, statusCode: number, error: string, message: string) {
  return reply.status(statusCode).send({ statusCode, error, message });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie-authenticated writes must come from the console's own origin. Together with the
 * custom workspace header (which a cross-site form cannot set) this blocks CSRF.
 */
function passesCsrfCheck(request: FastifyRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const origin = request.headers.origin;
  return typeof origin === "string" && env.CORS_ORIGIN_LIST.includes(origin);
}

/** Resolves the signed-in console user from the session cookie, if any. */
async function loadSessionUser(request: FastifyRequest): Promise<SessionUser | null> {
  if (request.sessionUser) return request.sessionUser;
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) return null;
  request.sessionUser = {
    id: session.user.id,
    email: session.user.email.toLowerCase(),
    name: session.user.name,
    emailVerified: session.user.emailVerified,
  };
  return request.sessionUser;
}

async function authenticateWithApiKey(request: FastifyRequest, reply: FastifyReply, token: string) {
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(token) },
    include: { organization: true },
  });

  if (!apiKey || apiKey.revokedAt) {
    return fail(reply, 401, "unauthorized", "Invalid API key provided.");
  }
  if (apiKey.expiresAt && apiKey.expiresAt <= new Date()) {
    return fail(reply, 401, "unauthorized", "This API key has expired.");
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
  request.principal = { kind: "api_key", apiKeyId: apiKey.id, name: apiKey.name, scopes: apiKey.scopes };
}

/**
 * Authenticates a workspace-scoped request: either `Authorization: Bearer <api key>`, or a
 * console session cookie plus the x-tredmail-workspace header naming a workspace the user
 * belongs to. Both produce `request.organization` and `request.principal.scopes`.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authenticateWithApiKey(request, reply, authHeader.substring(7).trim());
  }

  const user = await loadSessionUser(request);
  if (!user) {
    return fail(reply, 401, "unauthorized", "Missing credentials. Send 'Authorization: Bearer tred_live_...' or sign in.");
  }
  if (!passesCsrfCheck(request)) {
    return fail(reply, 403, "forbidden_origin", "This request did not come from the TredMail console.");
  }

  const workspaceId = request.headers[WORKSPACE_HEADER];
  if (typeof workspaceId !== "string" || !workspaceId) {
    return fail(reply, 400, "workspace_required", `Send the '${WORKSPACE_HEADER}' header to choose a workspace.`);
  }

  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: workspaceId, userId: user.id } },
    include: { organization: true },
  });
  if (!membership) {
    return fail(reply, 403, "not_a_member", "You are not a member of this workspace.");
  }

  request.organization = {
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
    isCommercial: membership.organization.isCommercial,
  };
  request.principal = {
    kind: "user",
    userId: user.id,
    email: user.email,
    role: membership.role,
    scopes: ROLE_SCOPES[membership.role],
  };
}

/** Back-compat name used by routes written before console sessions existed. */
export const authenticateApiKey = authenticate;

/** Console-only routes that do not act in a workspace (profile, creating a workspace). */
export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (request.headers.authorization) {
    return fail(reply, 403, "session_required", "This endpoint is only available to signed-in console users.");
  }
  const user = await loadSessionUser(request);
  if (!user) {
    return fail(reply, 401, "unauthorized", "Sign in to continue.");
  }
  if (!passesCsrfCheck(request)) {
    return fail(reply, 403, "forbidden_origin", "This request did not come from the TredMail console.");
  }
}

/**
 * Route-level guard: the caller (API key or member role) must hold `scope`.
 * Use after authenticate.
 */
export function requireScope(scope: ApiScope): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.principal || !hasScope(request.principal.scopes, scope)) {
      return fail(reply, 403, "insufficient_scope", `Your access is missing the '${scope}' permission.`);
    }
  };
}

/** Member management is for Owners and Admins signed in to the console. */
export const requireMemberManager: preHandlerHookHandler = async (request, reply) => {
  const principal = request.principal;
  if (principal?.kind !== "user" || !canManageMembers(principal.role)) {
    return fail(reply, 403, "insufficient_role", "Only workspace Owners and Admins can manage members.");
  }
};

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
    return fail(reply, 401, "unauthorized", "Invalid internal token.");
  }
}

/** Actor fields for audit entries. */
export function auditActor(request: FastifyRequest) {
  const principal = request.principal;
  if (principal?.kind === "user") return { actorType: "user" as const, actorId: principal.userId };
  if (principal?.kind === "api_key") return { actorType: "api_key" as const, actorId: principal.apiKeyId };
  return { actorType: "system" as const, actorId: null };
}
