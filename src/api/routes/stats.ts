import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../db/client.js";
import { authenticateApiKey } from "../middleware/auth.js";

export async function statsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateApiKey);

  // -------------------------------------------------------------
  // GET /v1/stats - Overall deliverability & engagement metrics
  // -------------------------------------------------------------
  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const orgId = request.organization!.id;

    // 1. Total emails count
    const totalEmails = await prisma.email.count({
      where: { organizationId: orgId },
    });

    const deliveredCount = await prisma.email.count({
      where: { organizationId: orgId, status: "DELIVERED" },
    });

    const bouncedCount = await prisma.email.count({
      where: { organizationId: orgId, status: "BOUNCED" },
    });

    // 2. Event counts (Opens & Clicks)
    const openedEvents = await prisma.emailEvent.count({
      where: {
        email: { organizationId: orgId },
        type: "OPENED",
      },
    });

    const clickedEvents = await prisma.emailEvent.count({
      where: {
        email: { organizationId: orgId },
        type: "CLICKED",
      },
    });

    // 3. Compute rates
    const deliveryRate = totalEmails > 0 ? ((deliveredCount / totalEmails) * 100).toFixed(1) : "100.0";
    const openRate = deliveredCount > 0 ? ((openedEvents / deliveredCount) * 100).toFixed(1) : "0.0";
    const clickRate = deliveredCount > 0 ? ((clickedEvents / deliveredCount) * 100).toFixed(1) : "0.0";
    const bounceRate = totalEmails > 0 ? ((bouncedCount / totalEmails) * 100).toFixed(2) : "0.00";

    // 4. Recent live email feed
    const recentEmails = await prisma.email.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        from: true,
        to: true,
        subject: true,
        status: true,
        createdAt: true,
        deliveredAt: true,
      },
    });

    return reply.status(200).send({
      metrics: {
        totalEmails,
        deliveredCount,
        bouncedCount,
        openedEvents,
        clickedEvents,
        deliveryRate: `${deliveryRate}%`,
        openRate: `${openRate}%`,
        clickRate: `${clickRate}%`,
        bounceRate: `${bounceRate}%`,
      },
      recentEmails,
    });
  });
}
