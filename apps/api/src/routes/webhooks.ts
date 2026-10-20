import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@tredmail/db";
import { auditActor, authenticate, requireScope } from "../middleware/auth.js";
import { recordAudit } from "@tredmail/core/services/audit";
import {
  WEBHOOK_EVENT_TYPES,
  assertWebhookUrlAllowed,
  deliverWebhook,
  generateWebhookSecret,
  replayWebhookDelivery,
} from "@tredmail/core/webhooks/dispatcher";
import { UnsafeUrlError } from "@tredmail/core/security/url-safety";

const updateWebhookSchema = z.object({
  url: z.string().url().max(2048).optional(),
  subscribed_to: z.array(z.enum(["*", ...WEBHOOK_EVENT_TYPES])).min(1).optional(),
  is_active: z.boolean().optional(),
});

const deliveriesQuerySchema = z.object({
  status: z.enum(["pending", "succeeded", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(64).optional(),
});

const notFound = { statusCode: 404, error: "not_found", message: "Webhook endpoint not found." };

const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  subscribed_to: z
    .array(z.enum(["*", ...WEBHOOK_EVENT_TYPES]))
    .min(1)
    .optional()
    .default(["email.delivered", "email.bounced"]),
});

export async function webhookRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", requireScope("webhooks:manage"));

  // GET /v1/webhooks - List endpoints. Signing secrets are shown only once, at creation.
  fastify.get("/", async (request, reply) => {
    const webhooks = await prisma.webhook.findMany({
      where: { organizationId: request.organization!.id },
      include: { _count: { select: { deliveries: true } } },
      orderBy: { createdAt: "desc" },
    });
    const failedRows = await prisma.webhookDelivery.groupBy({
      by: ["webhookId"],
      where: { webhookId: { in: webhooks.map((w) => w.id) }, status: "failed", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      _count: { _all: true },
    });
    const failedCounts = new Map(failedRows.map((r) => [r.webhookId, r._count._all]));

    return reply.status(200).send({
      data: webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        subscribed_to: w.subscribedTo,
        is_active: w.isActive,
        total_deliveries: w._count.deliveries,
        failed_deliveries_7d: failedCounts.get(w.id) ?? 0,
        created_at: w.createdAt.toISOString(),
      })),
    });
  });

  // POST /v1/webhooks - Create an endpoint
  fastify.post("/", async (request, reply) => {
    const parseResult = createWebhookSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "Invalid webhook configuration.",
        details: parseResult.error.errors,
      });
    }

    const { url, subscribed_to } = parseResult.data;
    try {
      await assertWebhookUrlAllowed(url);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        return reply.status(422).send({ statusCode: 422, error: "unsafe_url", message: err.message });
      }
      throw err;
    }

    const webhook = await prisma.webhook.create({
      data: {
        organizationId: request.organization!.id,
        url,
        secret: generateWebhookSecret(),
        subscribedTo: subscribed_to,
        isActive: true,
      },
    });

    await recordAudit({
      organizationId: request.organization!.id,
      ...auditActor(request),
      action: "webhook.created",
      targetType: "webhook",
      targetId: webhook.id,
      metadata: { url, subscribed_to },
      ipAddress: request.ip,
    });

    return reply.status(201).send({
      id: webhook.id,
      url: webhook.url,
      secret: webhook.secret, // shown once; store it to verify signatures
      subscribed_to: webhook.subscribedTo,
      is_active: webhook.isActive,
      created_at: webhook.createdAt.toISOString(),
    });
  });

  // DELETE /v1/webhooks/:id
  fastify.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const webhook = await prisma.webhook.findFirst({
      where: { id: request.params.id, organizationId: request.organization!.id },
    });
    if (!webhook) {
      return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Webhook endpoint not found." });
    }

    await prisma.webhook.delete({ where: { id: webhook.id } });
    await recordAudit({
      organizationId: request.organization!.id,
      ...auditActor(request),
      action: "webhook.deleted",
      targetType: "webhook",
      targetId: webhook.id,
      metadata: { url: webhook.url },
      ipAddress: request.ip,
    });
    return reply.status(200).send({ success: true, message: "Webhook deleted." });
  });

  // POST /v1/webhooks/:id/test - Send a test event to this endpoint only
  fastify.post<{ Params: { id: string } }>("/:id/test", async (request, reply) => {
    const webhook = await prisma.webhook.findFirst({
      where: { id: request.params.id, organizationId: request.organization!.id },
    });
    if (!webhook) {
      return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Webhook endpoint not found." });
    }

    const result = await deliverWebhook(webhook, "email.delivered", {
      email_id: `test_${Date.now()}`,
      to: ["test@example.com"],
      subject: "TredMail test event",
      is_test: true,
    });

    return reply.status(200).send({
      success: result.success,
      status_code: result.statusCode,
      message: result.success ? `Test event delivered to ${webhook.url}` : `Delivery to ${webhook.url} failed.`,
    });
  });

  const findWebhook = (organizationId: string, id: string) => prisma.webhook.findFirst({ where: { id, organizationId } });

  // PATCH /v1/webhooks/:id - Change URL or events, pause or resume
  fastify.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const parsed = updateWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ statusCode: 400, error: "validation_error", message: "Invalid webhook update.", details: parsed.error.errors });
    }
    const webhook = await findWebhook(request.organization!.id, request.params.id);
    if (!webhook) return reply.status(404).send(notFound);
    const { url, subscribed_to, is_active } = parsed.data;
    if (url) {
      try {
        await assertWebhookUrlAllowed(url);
      } catch (err) {
        if (err instanceof UnsafeUrlError) return reply.status(422).send({ statusCode: 422, error: "unsafe_url", message: err.message });
        throw err;
      }
    }
    const updated = await prisma.webhook.update({
      where: { id: webhook.id },
      data: { url, subscribedTo: subscribed_to, isActive: is_active },
    });
    await recordAudit({
      organizationId: request.organization!.id,
      ...auditActor(request),
      action: "webhook.updated",
      targetType: "webhook",
      targetId: webhook.id,
      metadata: { url: updated.url, subscribed_to: updated.subscribedTo, is_active: updated.isActive },
      ipAddress: request.ip,
    });
    return reply.send({
      id: updated.id,
      url: updated.url,
      subscribed_to: updated.subscribedTo,
      is_active: updated.isActive,
      created_at: updated.createdAt.toISOString(),
    });
  });

  // POST /v1/webhooks/:id/rotate-secret - New signing secret, shown once
  fastify.post<{ Params: { id: string } }>("/:id/rotate-secret", async (request, reply) => {
    const webhook = await findWebhook(request.organization!.id, request.params.id);
    if (!webhook) return reply.status(404).send(notFound);
    const updated = await prisma.webhook.update({ where: { id: webhook.id }, data: { secret: generateWebhookSecret() } });
    await recordAudit({
      organizationId: request.organization!.id,
      ...auditActor(request),
      action: "webhook.secret_rotated",
      targetType: "webhook",
      targetId: webhook.id,
      ipAddress: request.ip,
    });
    return reply.send({ id: updated.id, secret: updated.secret });
  });

  // GET /v1/webhooks/:id/deliveries?status=&limit=&cursor= - Delivery log, newest first
  fastify.get<{ Params: { id: string } }>("/:id/deliveries", async (request, reply) => {
    const parsed = deliveriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ statusCode: 400, error: "validation_error", message: "Invalid list parameters.", details: parsed.error.errors });
    }
    const webhook = await findWebhook(request.organization!.id, request.params.id);
    if (!webhook) return reply.status(404).send(notFound);
    const { status, limit, cursor } = parsed.data;
    const rows = await prisma.webhookDelivery.findMany({
      where: { webhookId: webhook.id, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return reply.send({
      data: page.map((d) => ({
        id: d.id,
        event: d.event,
        message_id: d.messageId,
        status: d.status,
        attempts: d.attempts,
        status_code: d.statusCode,
        response: d.response,
        payload: d.payload,
        created_at: d.createdAt.toISOString(),
        last_attempt_at: d.lastAttemptAt?.toISOString() ?? null,
        next_attempt_at: d.nextAttemptAt?.toISOString() ?? null,
      })),
      next_cursor: hasMore ? page[page.length - 1].id : null,
    });
  });

  // POST /v1/webhooks/:id/deliveries/:deliveryId/replay - Send one delivery again
  fastify.post<{ Params: { id: string; deliveryId: string } }>("/:id/deliveries/:deliveryId/replay", async (request, reply) => {
    const webhook = await findWebhook(request.organization!.id, request.params.id);
    if (!webhook) return reply.status(404).send(notFound);
    if (!webhook.isActive) {
      return reply.status(409).send({ statusCode: 409, error: "webhook_inactive", message: "Resume the endpoint before replaying deliveries." });
    }
    const delivery = await prisma.webhookDelivery.findFirst({ where: { id: request.params.deliveryId, webhookId: webhook.id } });
    if (!delivery) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Delivery not found." });
    await replayWebhookDelivery(delivery.id);
    return reply.status(202).send({ id: delivery.id, status: "pending" });
  });

  // POST /v1/webhooks/:id/replay-failed - Replay every failed delivery of the last 7 days
  fastify.post<{ Params: { id: string } }>("/:id/replay-failed", async (request, reply) => {
    const webhook = await findWebhook(request.organization!.id, request.params.id);
    if (!webhook) return reply.status(404).send(notFound);
    if (!webhook.isActive) {
      return reply.status(409).send({ statusCode: 409, error: "webhook_inactive", message: "Resume the endpoint before replaying deliveries." });
    }
    const failed = await prisma.webhookDelivery.findMany({
      where: { webhookId: webhook.id, status: "failed", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      select: { id: true },
      take: 1000,
    });
    for (const d of failed) await replayWebhookDelivery(d.id);
    return reply.status(202).send({ replayed: failed.length });
  });
}
