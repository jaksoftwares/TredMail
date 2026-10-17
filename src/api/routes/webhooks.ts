import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../../db/client.js";
import { authenticateApiKey } from "../middleware/auth.js";
import { dispatchWebhookEvent } from "../../webhooks/dispatcher.js";

const createWebhookSchema = z.object({
  url: z.string().url(),
  subscribed_to: z.array(z.string()).optional().default(["email.delivered", "email.bounced"]),
});

export async function webhookRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateApiKey);

  // -------------------------------------------------------------
  // GET /v1/webhooks - List webhooks
  // -------------------------------------------------------------
  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const webhooks = await prisma.webhook.findMany({
      where: { organizationId: request.organization!.id },
      include: {
        _count: { select: { deliveries: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return reply.status(200).send({
      data: webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        secret: w.secret,
        subscribed_to: w.subscribedTo,
        is_active: w.isActive,
        total_deliveries: w._count.deliveries,
        created_at: w.createdAt.toISOString(),
      })),
    });
  });

  // -------------------------------------------------------------
  // POST /v1/webhooks - Create webhook
  // -------------------------------------------------------------
  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
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
    const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;

    const webhook = await prisma.webhook.create({
      data: {
        organizationId: request.organization!.id,
        url,
        secret,
        subscribedTo: subscribed_to,
        isActive: true,
      },
    });

    return reply.status(201).send({
      id: webhook.id,
      url: webhook.url,
      secret: webhook.secret,
      subscribed_to: webhook.subscribedTo,
      is_active: webhook.isActive,
      created_at: webhook.createdAt.toISOString(),
    });
  });

  // -------------------------------------------------------------
  // DELETE /v1/webhooks/:id - Delete webhook
  // -------------------------------------------------------------
  fastify.delete("/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const webhook = await prisma.webhook.findFirst({
      where: { id, organizationId: request.organization!.id },
    });

    if (!webhook) {
      return reply.status(404).send({
        statusCode: 404,
        error: "not_found",
        message: "Webhook endpoint not found.",
      });
    }

    await prisma.webhook.delete({ where: { id } });

    return reply.status(200).send({ success: true, message: "Webhook deleted." });
  });

  // -------------------------------------------------------------
  // POST /v1/webhooks/:id/test - Send a test ping
  // -------------------------------------------------------------
  fastify.post("/:id/test", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const webhook = await prisma.webhook.findFirst({
      where: { id, organizationId: request.organization!.id },
    });

    if (!webhook) {
      return reply.status(404).send({
        statusCode: 404,
        error: "not_found",
        message: "Webhook endpoint not found.",
      });
    }

    await dispatchWebhookEvent(request.organization!.id, "email.delivered", {
      email_id: "test_msg_" + Date.now(),
      to: ["test@example.com"],
      from: "system@dovepeak.com",
      subject: "Test Webhook Ping",
      smtp_response: "250 2.0.0 Ok: test ping successful",
      is_test: true,
    });

    return reply.status(200).send({
      success: true,
      message: "Test ping dispatched to " + webhook.url,
    });
  });
}
