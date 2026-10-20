import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { authenticateApiKey, requireScope } from "../middleware/auth.js";
import { acceptEmail, sendEmailSchema } from "../../services/email-service.js";

const batchSchema = z.array(sendEmailSchema).min(1).max(100);

/**
 * POST /v1/emails/batch and its alias POST /v1/batch share this handler.
 * Each message is validated and accepted independently; one failure does not stop the rest.
 */
export async function sendBatch(request: FastifyRequest, reply: FastifyReply) {
  const parseResult = batchSchema.safeParse(request.body);
  if (!parseResult.success) {
    return reply.status(400).send({
      statusCode: 400,
      error: "validation_error",
      message: "Expected an array of 1 to 100 email objects.",
      details: parseResult.error.errors,
    });
  }

  const orgId = request.organization!.id;
  const data = [];
  for (const item of parseResult.data) {
    const result = await acceptEmail(orgId, item);
    data.push(result.ok ? { id: result.email.id, status: "queued" } : { error: result.error, message: result.message });
  }

  return reply.status(200).send({ data });
}

export async function emailRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateApiKey);

  // POST /v1/emails - Send a single email (Resend-compatible payload)
  fastify.post("/", { preHandler: requireScope("emails:send") }, async (request, reply) => {
    const parseResult = sendEmailSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "Invalid email payload.",
        details: parseResult.error.errors,
      });
    }

    const result = await acceptEmail(request.organization!.id, parseResult.data);
    if (!result.ok) {
      return reply.status(result.statusCode).send({
        statusCode: result.statusCode,
        error: result.error,
        message: result.message,
      });
    }

    return reply.status(200).send({
      id: result.email.id,
      from: result.email.from,
      to: result.email.to,
      status: "queued",
      created_at: result.email.createdAt.toISOString(),
    });
  });

  // POST /v1/emails/batch - Send up to 100 emails
  fastify.post("/batch", { preHandler: requireScope("emails:send") }, sendBatch);

  // GET /v1/emails/:id - Email status and event timeline
  fastify.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requireScope("emails:read") },
    async (request, reply) => {
      const email = await prisma.email.findFirst({
        where: { id: request.params.id, organizationId: request.organization!.id },
        include: {
          domain: { select: { name: true } },
          events: { orderBy: { timestamp: "asc" } },
        },
      });

      if (!email) {
        return reply.status(404).send({
          statusCode: 404,
          error: "not_found",
          message: `Email '${request.params.id}' not found.`,
        });
      }

      return reply.status(200).send({
        id: email.id,
        domain: email.domain.name,
        from: email.from,
        to: email.to,
        subject: email.subject,
        status: email.status.toLowerCase(),
        created_at: email.createdAt.toISOString(),
        delivered_at: email.deliveredAt?.toISOString() || null,
        smtp_response: email.smtpResponse,
        events: email.events.map((e) => ({
          id: e.id,
          type: e.type.toLowerCase(),
          timestamp: e.timestamp.toISOString(),
          ip_address: e.ipAddress,
          user_agent: e.userAgent,
          link_url: e.linkUrl,
          details: e.details,
        })),
      });
    }
  );
}
