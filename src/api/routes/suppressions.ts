import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { authenticateApiKey } from "../middleware/auth.js";

const createSuppressionSchema = z.object({
  email: z.string().email(),
  reason: z.enum(["HARD_BOUNCE", "SPAM_COMPLAINT", "UNSUBSCRIBE", "MANUAL"]).default("MANUAL"),
  notes: z.string().optional(),
});

export async function suppressionRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateApiKey);

  // -------------------------------------------------------------
  // GET /v1/suppressions - List suppressed emails
  // -------------------------------------------------------------
  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const suppressions = await prisma.suppression.findMany({
      where: { organizationId: request.organization!.id },
      orderBy: { createdAt: "desc" },
    });

    return reply.status(200).send({
      data: suppressions.map((s) => ({
        id: s.id,
        email: s.email,
        reason: s.reason,
        diagnostic: s.smtpDiagnostic,
        created_at: s.createdAt.toISOString(),
      })),
    });
  });

  // -------------------------------------------------------------
  // POST /v1/suppressions - Manually block an email
  // -------------------------------------------------------------
  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = createSuppressionSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "Invalid suppression data.",
        details: parseResult.error.errors,
      });
    }

    const { email, reason, notes } = parseResult.data;
    const orgId = request.organization!.id;

    const suppression = await prisma.suppression.upsert({
      where: {
        organizationId_email: {
          organizationId: orgId,
          email: email.toLowerCase().trim(),
        },
      },
      update: {
        reason,
        smtpDiagnostic: notes,
      },
      create: {
        organizationId: orgId,
        email: email.toLowerCase().trim(),
        reason,
        smtpDiagnostic: notes,
      },
    });

    return reply.status(201).send({
      id: suppression.id,
      email: suppression.email,
      reason: suppression.reason,
      created_at: suppression.createdAt.toISOString(),
    });
  });

  // -------------------------------------------------------------
  // DELETE /v1/suppressions/:id - Unblock an email
  // -------------------------------------------------------------
  fastify.delete("/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const item = await prisma.suppression.findFirst({
      where: { id, organizationId: request.organization!.id },
    });

    if (!item) {
      return reply.status(404).send({
        statusCode: 404,
        error: "not_found",
        message: "Suppressed email not found.",
      });
    }

    await prisma.suppression.delete({ where: { id } });

    return reply.status(200).send({
      success: true,
      message: `Unblocked '${item.email}'. It can now receive emails again.`,
    });
  });
}
