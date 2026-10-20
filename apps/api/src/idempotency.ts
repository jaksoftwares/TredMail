import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma, type Prisma } from "@tredmail/db";

export interface HandlerResult {
  statusCode: number;
  body: unknown;
}

const IN_PROGRESS_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs `handler` at most once per Idempotency-Key and workspace (keys are kept 24 hours):
 *  - same key, same request: the stored response is returned with `Idempotent-Replayed: true`;
 *  - same key, different request: 422, so a client bug cannot silently send the wrong email;
 *  - same key while the first request is still running: 409, retry shortly.
 * Server errors (5xx) are not stored, so the client may retry them with the same key.
 */
export async function withIdempotency(
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<HandlerResult>,
): Promise<FastifyReply> {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    const result = await handler();
    return reply.status(result.statusCode).send(result.body);
  }
  if (key.length > 256) {
    return reply.status(400).send({ statusCode: 400, error: "invalid_idempotency_key", message: "Idempotency-Key must be at most 256 characters." });
  }

  const organizationId = request.organization!.id;
  const requestHash = crypto
    .createHash("sha256")
    .update(`${request.method} ${request.routeOptions.url}\n${JSON.stringify(request.body ?? null)}`)
    .digest("hex");

  let recordId: string;
  // skipDuplicates makes the insert a no-op (instead of an error) when the key exists
  const inserted = await prisma.idempotencyKey.createMany({ data: [{ organizationId, key, requestHash }], skipDuplicates: true });
  if (inserted.count === 1) {
    recordId = (await prisma.idempotencyKey.findUniqueOrThrow({ where: { organizationId_key: { organizationId, key } } })).id;
  } else {
    const existing = await prisma.idempotencyKey.findUnique({ where: { organizationId_key: { organizationId, key } } });
    if (!existing) return withIdempotency(request, reply, handler); // expired in between
    if (existing.requestHash !== requestHash) {
      return reply.status(422).send({
        statusCode: 422,
        error: "idempotency_key_reused",
        message: "This Idempotency-Key was already used with a different request. Use a new key for a new email.",
      });
    }
    if (existing.statusCode !== null) {
      return reply.header("Idempotent-Replayed", "true").status(existing.statusCode).send(existing.response);
    }
    if (Date.now() - existing.createdAt.getTime() < IN_PROGRESS_TIMEOUT_MS) {
      return reply.status(409).send({
        statusCode: 409,
        error: "idempotency_in_progress",
        message: "A request with this Idempotency-Key is still being processed. Retry in a few seconds.",
      });
    }
    // The first request died without finishing: let this one take over.
    recordId = existing.id;
  }

  let result: HandlerResult;
  try {
    result = await handler();
  } catch (err) {
    await prisma.idempotencyKey.delete({ where: { id: recordId } }).catch(() => undefined);
    throw err;
  }
  if (result.statusCode >= 500) {
    await prisma.idempotencyKey.delete({ where: { id: recordId } }).catch(() => undefined);
  } else {
    await prisma.idempotencyKey.update({
      where: { id: recordId },
      data: { statusCode: result.statusCode, response: result.body as Prisma.InputJsonValue },
    });
  }
  return reply.status(result.statusCode).send(result.body);
}
