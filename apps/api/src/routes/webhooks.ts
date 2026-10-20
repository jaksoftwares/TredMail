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
} from "@tredmail/core/webhooks/dispatcher";
import { UnsafeUrlError } from "@tredmail/core/security/url-safety";

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

    return reply.status(200).send({
      data: webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        subscribed_to: w.subscribedTo,
        is_active: w.isActive,
        total_deliveries: w._count.deliveries,
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
}
