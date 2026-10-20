import type { FastifyInstance, FastifyRequest } from "fastify";
import { auth } from "../auth.js";

/** Converts a Fastify request into the Fetch API Request that Better Auth expects. */
function toFetchRequest(request: FastifyRequest): Request {
  const url = new URL(request.url, `${request.protocol}://${request.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined;
  return new Request(url, {
    method: request.method,
    headers,
    body: hasBody ? (typeof request.body === "string" ? request.body : JSON.stringify(request.body)) : undefined,
  });
}

/**
 * Mounts Better Auth at /api/auth/* (sign-up, sign-in, verification, password reset,
 * OAuth callbacks, two-factor). The console proxies this path, so cookies are first-party.
 */
export async function authHandlerRoutes(fastify: FastifyInstance) {
  fastify.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      const response = await auth.handler(toFetchRequest(request));

      reply.status(response.status);
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() !== "set-cookie") reply.header(name, value);
      });
      // Each cookie must stay its own Set-Cookie header.
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);

      return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
    },
  });
}
