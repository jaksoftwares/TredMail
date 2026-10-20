import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "@tredmail/db";
import { authenticate, requireScope } from "../middleware/auth.js";
import { acceptEmail, sendEmailSchema } from "@tredmail/core/services/email-service";

const batchSchema = z.array(sendEmailSchema).min(1).max(100);

const listQuerySchema = z.object({
  status: z
    .enum(["queued", "sending", "sent", "delivered", "failed", "bounced", "complained"])
    .transform((s) => s.toUpperCase() as "QUEUED" | "SENDING" | "SENT" | "DELIVERED" | "FAILED" | "BOUNCED" | "COMPLAINED")
    .optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(64).optional(),
});

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
  fastify.addHook("preHandler", authenticate);

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

  // GET /v1/emails?status=&q=&limit=&cursor= - Newest first, cursor-paginated
  fastify.get<{ Querystring: { status?: string; q?: string; limit?: string; cursor?: string } }>(
    "/",
    { preHandler: requireScope("emails:read") },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: "validation_error",
          message: "Invalid list parameters.",
          details: parsed.error.errors,
        });
      }
      const { status, q, limit, cursor } = parsed.data;
      const search = q?.trim().toLowerCase();

      const emails = await prisma.email.findMany({
        where: {
          organizationId: request.organization!.id,
          ...(status ? { status } : {}),
          ...(search
            ? {
                OR: [
                  { subject: { contains: search, mode: "insensitive" as const } },
                  { from: { contains: search, mode: "insensitive" as const } },
                  { to: { has: search } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, from: true, to: true, subject: true, status: true, createdAt: true, deliveredAt: true },
      });

      const hasMore = emails.length > limit;
      const page = hasMore ? emails.slice(0, limit) : emails;
      return reply.status(200).send({
        data: page.map((e) => ({
          id: e.id,
          from: e.from,
          to: e.to,
          subject: e.subject,
          status: e.status.toLowerCase(),
          created_at: e.createdAt.toISOString(),
          delivered_at: e.deliveredAt?.toISOString() ?? null,
        })),
        next_cursor: hasMore ? page[page.length - 1].id : null,
      });
    }
  );

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
        cc: email.cc,
        bcc: email.bcc,
        reply_to: email.replyTo,
        subject: email.subject,
        html: email.htmlBody,
        text: email.textBody,
        tags: email.tags,
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
