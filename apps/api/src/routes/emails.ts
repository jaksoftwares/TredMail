import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma, type EmailStatus, type Prisma } from "@tredmail/db";
import { authenticate, requireScope } from "../middleware/auth.js";
import { withIdempotency, type HandlerResult } from "../idempotency.js";
import {
  acceptEmail,
  cancelScheduledEmail,
  rescheduleEmail,
  sendEmailSchema,
  type AcceptResult,
} from "@tredmail/core/services/email-service";
import { dispatchWebhookEvent } from "@tredmail/core/webhooks/dispatcher";

const batchSchema = z.array(sendEmailSchema).min(1).max(100);

const STATUSES = ["scheduled", "canceled", "queued", "sending", "sent", "delivered", "failed", "bounced", "complained"] as const;

const listQuerySchema = z.object({
  status: z
    .string()
    .transform((value) => value.split(",").map((s) => s.trim().toLowerCase()))
    .pipe(z.array(z.enum(STATUSES)).min(1))
    .transform((list) => list.map((s) => s.toUpperCase() as EmailStatus))
    .optional(),
  q: z.string().max(200).optional(),
  domain: z.string().max(253).optional(),
  tag: z.string().max(513).optional(), // name or name:value
  template: z.string().max(128).optional(),
  after: z.string().datetime({ offset: true }).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(64).optional(),
});

const rescheduleSchema = z.object({ scheduled_at: z.string().datetime({ offset: true }) });

const validationError = (message: string, details: unknown): HandlerResult => ({
  statusCode: 400,
  body: { statusCode: 400, error: "validation_error", message, details },
});

const failure = (result: Extract<AcceptResult, { ok: false }>): HandlerResult => ({
  statusCode: result.statusCode,
  body: { statusCode: result.statusCode, error: result.error, message: result.message },
});

function accepted(result: Extract<AcceptResult, { ok: true }>) {
  return {
    id: result.email.id,
    from: result.email.from,
    to: result.email.to,
    status: result.email.status,
    scheduled_at: result.email.scheduledAt?.toISOString() ?? null,
    created_at: result.email.createdAt.toISOString(),
  };
}

async function announce(organizationId: string, result: Extract<AcceptResult, { ok: true }>) {
  await dispatchWebhookEvent(organizationId, result.email.status === "scheduled" ? "email.scheduled" : "email.queued", {
    email_id: result.email.id,
    from: result.email.from,
    to: result.email.to,
    scheduled_at: result.email.scheduledAt?.toISOString() ?? null,
  }).catch((err) => console.error("webhook dispatch failed", err));
}

/**
 * POST /v1/emails/batch and its alias POST /v1/batch share this handler.
 * Each message is validated and accepted independently; one failure does not stop the rest.
 */
export async function sendBatch(request: FastifyRequest, reply: FastifyReply) {
  return withIdempotency(request, reply, async () => {
    const parseResult = batchSchema.safeParse(request.body);
    if (!parseResult.success) {
      return validationError("Expected an array of 1 to 100 email objects.", parseResult.error.errors);
    }
    const orgId = request.organization!.id;
    const data = [];
    for (const item of parseResult.data) {
      const result = await acceptEmail(orgId, item);
      if (result.ok) {
        await announce(orgId, result);
        data.push(accepted(result));
      } else {
        data.push({ error: result.error, message: result.message });
      }
    }
    return { statusCode: 200, body: { data } };
  });
}

function serializeSummary(e: {
  id: string;
  from: string;
  to: string[];
  subject: string;
  status: EmailStatus;
  createdAt: Date;
  deliveredAt: Date | null;
  scheduledAt: Date | null;
}) {
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    subject: e.subject,
    status: e.status.toLowerCase(),
    created_at: e.createdAt.toISOString(),
    scheduled_at: e.scheduledAt?.toISOString() ?? null,
    delivered_at: e.deliveredAt?.toISOString() ?? null,
  };
}

export async function emailRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);

  // POST /v1/emails - Send a single email (Resend-compatible payload)
  fastify.post("/", { preHandler: requireScope("emails:send") }, async (request, reply) =>
    withIdempotency(request, reply, async () => {
      const parseResult = sendEmailSchema.safeParse(request.body);
      if (!parseResult.success) return validationError("Invalid email payload.", parseResult.error.errors);
      const result = await acceptEmail(request.organization!.id, parseResult.data);
      if (!result.ok) return failure(result);
      await announce(request.organization!.id, result);
      return { statusCode: 200, body: accepted(result) };
    }),
  );

  // POST /v1/emails/batch - Send up to 100 emails
  fastify.post("/batch", { preHandler: requireScope("emails:send") }, sendBatch);

  // GET /v1/emails - Newest first, cursor-paginated, filterable
  fastify.get("/", { preHandler: requireScope("emails:read") }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const result = validationError("Invalid list parameters.", parsed.error.errors);
      return reply.status(result.statusCode).send(result.body);
    }
    const { status, q, domain, tag, template, after, before, limit, cursor } = parsed.data;
    const search = q?.trim().toLowerCase();
    const [tagName, tagValue] = tag ? tag.split(/:(.*)/s) : [];

    const where: Prisma.EmailWhereInput = {
      organizationId: request.organization!.id,
      ...(status ? { status: { in: status } } : {}),
      ...(domain ? { domain: { name: domain.toLowerCase() } } : {}),
      ...(template ? { template: { OR: [{ id: template }, { alias: template.toLowerCase() }] } } : {}),
      ...(after || before
        ? { createdAt: { ...(after ? { gte: new Date(after) } : {}), ...(before ? { lt: new Date(before) } : {}) } }
        : {}),
      ...(tagName ? { tags: { array_contains: [tagValue ? { name: tagName, value: tagValue } : { name: tagName }] } } : {}),
      ...(search
        ? {
            OR: [
              { id: search },
              { subject: { contains: search, mode: "insensitive" as const } },
              { from: { contains: search, mode: "insensitive" as const } },
              { to: { has: search } },
            ],
          }
        : {}),
    };

    const emails = await prisma.email.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, from: true, to: true, subject: true, status: true, createdAt: true, deliveredAt: true, scheduledAt: true },
    });

    const hasMore = emails.length > limit;
    const page = hasMore ? emails.slice(0, limit) : emails;
    return reply.status(200).send({
      data: page.map(serializeSummary),
      next_cursor: hasMore ? page[page.length - 1].id : null,
    });
  });

  // GET /v1/emails/:id - Email status and event timeline
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler: requireScope("emails:read") }, async (request, reply) => {
    const email = await prisma.email.findFirst({
      where: { id: request.params.id, organizationId: request.organization!.id },
      include: {
        domain: { select: { name: true } },
        template: { select: { id: true, alias: true } },
        attachments: { select: { filename: true, contentType: true, size: true } },
        events: { orderBy: { timestamp: "asc" } },
      },
    });

    if (!email) {
      return reply.status(404).send({ statusCode: 404, error: "not_found", message: `Email '${request.params.id}' not found.` });
    }

    return reply.status(200).send({
      ...serializeSummary(email),
      domain: email.domain.name,
      cc: email.cc,
      bcc: email.bcc,
      reply_to: email.replyTo,
      html: email.htmlBody,
      text: email.textBody,
      tags: email.tags,
      template: email.template ? { id: email.template.id, alias: email.template.alias } : null,
      attachments: email.attachments.map((a) => ({ filename: a.filename, content_type: a.contentType, size: a.size })),
      track_opens: email.trackOpens,
      track_clicks: email.trackClicks,
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
  });

  // POST /v1/emails/:id/cancel - Cancel a scheduled email
  fastify.post<{ Params: { id: string } }>("/:id/cancel", { preHandler: requireScope("emails:send") }, async (request, reply) => {
    const orgId = request.organization!.id;
    const result = await cancelScheduledEmail(orgId, request.params.id);
    if (!result.ok) return reply.status(result.statusCode).send({ statusCode: result.statusCode, error: result.error, message: result.message });
    await dispatchWebhookEvent(orgId, "email.canceled", { email_id: request.params.id }).catch(() => undefined);
    return reply.status(200).send({ id: request.params.id, status: "canceled" });
  });

  // PATCH /v1/emails/:id - Reschedule a scheduled email
  fastify.patch<{ Params: { id: string } }>("/:id", { preHandler: requireScope("emails:send") }, async (request, reply) => {
    const parsed = rescheduleSchema.safeParse(request.body);
    if (!parsed.success) {
      const result = validationError("Send { \"scheduled_at\": \"<ISO 8601 time>\" }.", parsed.error.errors);
      return reply.status(result.statusCode).send(result.body);
    }
    const result = await rescheduleEmail(request.organization!.id, request.params.id, parsed.data.scheduled_at);
    if (!result.ok) return reply.status(result.statusCode).send({ statusCode: result.statusCode, error: result.error, message: result.message });
    return reply.status(200).send({
      id: request.params.id,
      status: result.scheduledAt ? "scheduled" : "queued",
      scheduled_at: result.scheduledAt?.toISOString() ?? null,
    });
  });
}
