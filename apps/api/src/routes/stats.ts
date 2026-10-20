import type { FastifyInstance } from "fastify";
import { prisma } from "@tredmail/db";
import { authenticate, requireScope } from "../middleware/auth.js";

const percent = (part: number, whole: number, digits = 1) =>
  `${whole > 0 ? ((part / whole) * 100).toFixed(digits) : (0).toFixed(digits)}%`;

export async function statsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", requireScope("stats:read"));

  // GET /v1/stats - Lifetime sending and engagement metrics, plus the 10 most recent emails
  fastify.get("/", async (request, reply) => {
    const orgId = request.organization!.id;

    const [byStatus, uniqueOpens, uniqueClicks, recentEmails] = await Promise.all([
      prisma.email.groupBy({ by: ["status"], where: { organizationId: orgId }, _count: { _all: true } }),
      prisma.emailEvent.findMany({
        where: { type: "OPENED", email: { organizationId: orgId } },
        distinct: ["emailId"],
        select: { emailId: true },
      }),
      prisma.emailEvent.findMany({
        where: { type: "CLICKED", email: { organizationId: orgId } },
        distinct: ["emailId"],
        select: { emailId: true },
      }),
      prisma.email.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, from: true, to: true, subject: true, status: true, createdAt: true, deliveredAt: true },
      }),
    ]);

    const count = (...statuses: string[]) =>
      byStatus.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0);

    const totalEmails = count("QUEUED", "SENDING", "SENT", "DELIVERED", "FAILED", "BOUNCED", "COMPLAINED");
    // "Accepted" = handed to the mail server. DELIVERED, BOUNCED and FAILED come from KumoMTA's
    // delivery log and from bounce reports; mail sent through the fallback relay stays SENT.
    const acceptedCount = count("SENT", "DELIVERED", "BOUNCED", "COMPLAINED");
    const deliveredCount = count("DELIVERED");
    const bouncedCount = count("BOUNCED");
    const failedCount = count("FAILED");
    const complainedCount = count("COMPLAINED");

    return reply.status(200).send({
      metrics: {
        totalEmails,
        acceptedCount,
        deliveredCount,
        bouncedCount,
        failedCount,
        complainedCount,
        uniqueOpens: uniqueOpens.length,
        uniqueClicks: uniqueClicks.length,
        acceptedRate: percent(acceptedCount, totalEmails),
        openRate: percent(uniqueOpens.length, acceptedCount),
        clickRate: percent(uniqueClicks.length, acceptedCount),
        bounceRate: percent(bouncedCount, acceptedCount, 2),
      },
      recentEmails,
    });
  });
}
