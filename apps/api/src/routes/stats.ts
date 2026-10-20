import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, Prisma } from "@tredmail/db";
import { authenticate, requireScope } from "../middleware/auth.js";

const percent = (part: number, whole: number, digits = 1) =>
  `${whole > 0 ? ((part / whole) * 100).toFixed(digits) : (0).toFixed(digits)}%`;

const timeseriesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  domain: z.string().max(253).optional(),
});

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

    const totalEmails = count("SCHEDULED", "QUEUED", "SENDING", "SENT", "DELIVERED", "FAILED", "BOUNCED", "COMPLAINED");
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

  // GET /v1/stats/timeseries?days=30&domain= - Emails per UTC day for each outcome.
  // Opens and clicks count unique emails, so one reader opening twice counts once.
  fastify.get("/timeseries", async (request, reply) => {
    const parsed = timeseriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ statusCode: 400, error: "validation_error", message: "Invalid parameters.", details: parsed.error.errors });
    }
    const { days, domain } = parsed.data;
    const orgId = request.organization!.id;
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (days - 1));

    const domainFilter = domain ? Prisma.sql`AND d."name" = ${domain.toLowerCase()}` : Prisma.empty;
    const rows = await prisma.$queryRaw<Array<{ day: Date; type: string; count: bigint }>>`
      SELECT date_trunc('day', ev."timestamp") AS day, ev."type"::text AS type, COUNT(DISTINCT ev."emailId") AS count
      FROM "email_events" ev
      JOIN "emails" e ON e."id" = ev."emailId"
      JOIN "domains" d ON d."id" = e."domainId"
      WHERE e."organizationId" = ${orgId}
        AND ev."timestamp" >= ${start}
        AND ev."type"::text IN ('SENT', 'DELIVERED', 'DEFERRED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'OPENED', 'CLICKED')
        ${domainFilter}
      GROUP BY 1, 2
      ORDER BY 1`;

    const series = new Map<string, Record<string, number>>();
    for (let i = 0; i < days; i++) {
      const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      series.set(day, { sent: 0, delivered: 0, deferred: 0, bounced: 0, complained: 0, failed: 0, opened: 0, clicked: 0 });
    }
    for (const row of rows) {
      const bucket = series.get(new Date(row.day).toISOString().slice(0, 10));
      if (bucket) bucket[row.type.toLowerCase()] = Number(row.count);
    }
    return reply.send({
      days,
      start: start.toISOString(),
      data: [...series.entries()].map(([date, counts]) => ({ date, ...counts })),
    });
  });

  // GET /v1/stats/domains?days=30 - Outcome totals per sending domain
  fastify.get("/domains", async (request, reply) => {
    const parsed = timeseriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ statusCode: 400, error: "validation_error", message: "Invalid parameters.", details: parsed.error.errors });
    }
    const since = new Date(Date.now() - parsed.data.days * 86_400_000);
    const rows = await prisma.$queryRaw<Array<{ domain: string; status: string; count: bigint }>>`
      SELECT d."name" AS domain, e."status"::text AS status, COUNT(*) AS count
      FROM "emails" e JOIN "domains" d ON d."id" = e."domainId"
      WHERE e."organizationId" = ${request.organization!.id} AND e."createdAt" >= ${since}
      GROUP BY 1, 2`;
    const byDomain = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const entry = byDomain.get(row.domain) ?? { total: 0 };
      entry[row.status.toLowerCase()] = Number(row.count);
      entry.total += Number(row.count);
      byDomain.set(row.domain, entry);
    }
    return reply.send({
      days: parsed.data.days,
      data: [...byDomain.entries()]
        .map(([domain, counts]) => {
          const attempted = (counts.delivered ?? 0) + (counts.bounced ?? 0) + (counts.complained ?? 0);
          return {
            domain,
            ...counts,
            total: counts.total,
            delivery_rate: attempted > 0 ? percent((counts.delivered ?? 0) + (counts.complained ?? 0), attempted) : null,
            bounce_rate: attempted > 0 ? percent(counts.bounced ?? 0, attempted, 2) : null,
          };
        })
        .sort((a, b) => b.total - a.total),
    });
  });
}
