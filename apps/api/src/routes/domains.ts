import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "@tredmail/db";
import { generateDkimKeypair } from "@tredmail/core/security/dkim-keys";
import { encryptSecret } from "@tredmail/core/security/crypto";
import { generateExpectedDnsRecords } from "@tredmail/core/dns/generator";
import { verifyDomainDns } from "@tredmail/core/dns/verifier";
import { auditActor, authenticate, requireScope } from "../middleware/auth.js";
import { recordAudit } from "@tredmail/core/services/audit";
import { env } from "@tredmail/core/config/env";

const createDomainSchema = z.object({
  name: z.string().min(3).regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Invalid domain name format"),
  region: z.string().optional().default("eu-central"),
});

export async function domainRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);

  // -------------------------------------------------------------
  // GET /v1/domains - List domains
  // -------------------------------------------------------------
  fastify.get("/", { preHandler: requireScope("domains:read") }, async (request: FastifyRequest, reply: FastifyReply) => {
    const domains = await prisma.domain.findMany({
      where: { organizationId: request.organization!.id },
      orderBy: { createdAt: "desc" },
    });

    const data = domains.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status.toLowerCase(),
      created_at: d.createdAt.toISOString(),
      region: d.region,
      records: generateExpectedDnsRecords(d.name, d.dkimSelector, d.dkimPublicKey),
    }));

    return reply.status(200).send({ data });
  });

  // -------------------------------------------------------------
  // POST /v1/domains - Register domain
  // -------------------------------------------------------------
  fastify.post("/", { preHandler: requireScope("domains:manage") }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = createDomainSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "Invalid domain payload.",
        details: parseResult.error.errors,
      });
    }

    const { name, region } = parseResult.data;
    const cleanName = name.toLowerCase().trim();
    const platformDomain = env.PRIMARY_DOMAIN.toLowerCase();

    if (cleanName === platformDomain || cleanName.endsWith(`.${platformDomain}`)) {
      return reply.status(422).send({
        statusCode: 422,
        error: "reserved_domain",
        message: `'${cleanName}' is reserved by TredMail. Use the sandbox sender or add your own domain.`,
      });
    }
    const orgId = request.organization!.id;

    // Check if domain already registered under this organization
    const existing = await prisma.domain.findFirst({
      where: { organizationId: orgId, name: cleanName },
    });

    if (existing) {
      return reply.status(409).send({
        statusCode: 409,
        error: "domain_conflict",
        message: `Domain '${cleanName}' is already registered in your account.`,
      });
    }

    // 1. Generate fresh RSA-2048 DKIM keypair
    const dkim = generateDkimKeypair();

    // 2. Encrypt private key with AES-256-GCM
    const encryptedPrivateKey = encryptSecret(dkim.privateKeyPem);

    // 3. Persist domain
    const domain = await prisma.domain.create({
      data: {
        organizationId: orgId,
        name: cleanName,
        region,
        status: "PENDING",
        dkimSelector: env.DEFAULT_DKIM_SELECTOR,
        dkimPublicKey: dkim.dnsTxtValue,
        dkimPrivateKey: encryptedPrivateKey,
      },
    });

    // 4. Return domain with all 4 DNS records formatted for instant copy-paste
    const records = generateExpectedDnsRecords(
      domain.name,
      domain.dkimSelector,
      domain.dkimPublicKey
    );

    await recordAudit({
      organizationId: orgId,
      ...auditActor(request),
      action: "domain.created",
      targetType: "domain",
      targetId: domain.id,
      metadata: { name: domain.name },
      ipAddress: request.ip,
    });

    return reply.status(201).send({
      id: domain.id,
      name: domain.name,
      status: domain.status.toLowerCase(),
      records,
      created_at: domain.createdAt.toISOString(),
    });
  });

  // -------------------------------------------------------------
  // GET /v1/domains/:id - One domain with its records and per-record verification
  // -------------------------------------------------------------
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler: requireScope("domains:read") }, async (request, reply) => {
    const d = await prisma.domain.findFirst({ where: { id: request.params.id, organizationId: request.organization!.id } });
    if (!d) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Domain not found." });
    const verified: Record<string, boolean> = {
      DKIM: d.dkimVerified,
      SPF: d.spfVerified,
      DMARC: d.dmarcVerified,
      RETURN_PATH: d.returnPathVerified,
    };
    return reply.send({
      id: d.id,
      name: d.name,
      status: d.status.toLowerCase(),
      region: d.region,
      created_at: d.createdAt.toISOString(),
      verified_at: d.verifiedAt?.toISOString() ?? null,
      last_checked_at: d.lastCheckedAt?.toISOString() ?? null,
      records: generateExpectedDnsRecords(d.name, d.dkimSelector, d.dkimPublicKey).map((r) => ({
        ...r,
        verified: verified[r.recordType] ?? false,
      })),
    });
  });

  // -------------------------------------------------------------
  // DELETE /v1/domains/:id - Remove a domain (its sent emails and their history go with it)
  // -------------------------------------------------------------
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler: requireScope("domains:manage") }, async (request, reply) => {
    const orgId = request.organization!.id;
    const d = await prisma.domain.findFirst({ where: { id: request.params.id, organizationId: orgId } });
    if (!d) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Domain not found." });
    const pending = await prisma.email.count({ where: { domainId: d.id, status: { in: ["SCHEDULED", "QUEUED", "SENDING"] } } });
    if (pending > 0) {
      return reply.status(409).send({
        statusCode: 409,
        error: "domain_in_use",
        message: `${pending} email(s) from ${d.name} are still waiting to be sent. Cancel them or wait until they are sent.`,
      });
    }
    await prisma.domain.delete({ where: { id: d.id } });
    await recordAudit({
      organizationId: orgId,
      ...auditActor(request),
      action: "domain.deleted",
      targetType: "domain",
      targetId: d.id,
      metadata: { name: d.name },
      ipAddress: request.ip,
    });
    return reply.send({ id: d.id, deleted: true });
  });

  // -------------------------------------------------------------
  // GET /v1/domains/:id/dmarc?days=30 - Summary of DMARC aggregate reports received
  // -------------------------------------------------------------
  fastify.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    "/:id/dmarc",
    { preHandler: requireScope("domains:read") },
    async (request, reply) => {
      const d = await prisma.domain.findFirst({ where: { id: request.params.id, organizationId: request.organization!.id } });
      if (!d) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Domain not found." });
      const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 365);
      const reports = await prisma.dmarcReport.findMany({
        where: { domainId: d.id, dateBegin: { gte: new Date(Date.now() - days * 86_400_000) } },
        orderBy: { dateBegin: "desc" },
      });
      const sources = new Map<string, { ip: string; count: number; pass: number; reporters: Set<string> }>();
      for (const report of reports) {
        for (const r of report.records as Array<{ ip: string; count: number; dkim: string; spf: string }>) {
          const entry = sources.get(r.ip) ?? { ip: r.ip, count: 0, pass: 0, reporters: new Set<string>() };
          entry.count += r.count;
          if (r.dkim === "pass" || r.spf === "pass") entry.pass += r.count;
          entry.reporters.add(report.reporter);
          sources.set(r.ip, entry);
        }
      }
      const total = reports.reduce((sum, r) => sum + r.messageCount, 0);
      const pass = reports.reduce((sum, r) => sum + r.dmarcPass, 0);
      return reply.send({
        domain: d.name,
        days,
        report_count: reports.length,
        message_count: total,
        pass_count: pass,
        pass_rate: total > 0 ? Number(((pass / total) * 100).toFixed(1)) : null,
        published_policy: reports[0]?.policy ?? null,
        sources: [...sources.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 50)
          .map((s) => ({ ip: s.ip, count: s.count, pass: s.pass, fail: s.count - s.pass, reporters: [...s.reporters] })),
        reports: reports.slice(0, 50).map((r) => ({
          reporter: r.reporter,
          report_id: r.reportId,
          date_begin: r.dateBegin.toISOString(),
          date_end: r.dateEnd.toISOString(),
          message_count: r.messageCount,
          pass_count: r.dmarcPass,
        })),
      });
    },
  );

  // -------------------------------------------------------------
  // POST /v1/domains/:id/verify - Actively verify DNS records
  // -------------------------------------------------------------
  fastify.post<{ Params: { id: string } }>("/:id/verify", { preHandler: requireScope("domains:manage") }, async (request, reply) => {
    const { id } = request.params;
    const orgId = request.organization!.id;

    const domain = await prisma.domain.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!domain) {
      return reply.status(404).send({
        statusCode: 404,
        error: "not_found",
        message: `Domain '${id}' not found.`,
      });
    }

    // Run active DNS query
    const report = await verifyDomainDns(
      domain.name,
      domain.dkimSelector,
      domain.dkimPublicKey,
      `_spf.${env.PRIMARY_DOMAIN}`,
      env.BOUNCE_DOMAIN
    );

    // A domain can be verified (and therefore sent from) by only one workspace.
    if (report.isFullyVerified) {
      const ownedElsewhere = await prisma.domain.findFirst({
        where: { name: domain.name, status: "VERIFIED", organizationId: { not: orgId } },
        select: { id: true },
      });
      if (ownedElsewhere) {
        return reply.status(409).send({
          statusCode: 409,
          error: "domain_owned_elsewhere",
          message: `'${domain.name}' is already verified by another TredMail workspace. Contact support if you own it.`,
        });
      }
    }

    const newStatus = report.isFullyVerified ? "VERIFIED" : domain.status;
    if (newStatus === "VERIFIED" && domain.status !== "VERIFIED") {
      await recordAudit({
        organizationId: orgId,
        ...auditActor(request),
        action: "domain.verified",
        targetType: "domain",
        targetId: domain.id,
        metadata: { name: domain.name },
        ipAddress: request.ip,
      });
    }

    await prisma.domain.update({
      where: { id: domain.id },
      data: {
        status: newStatus,
        dkimVerified: report.dkimVerified,
        spfVerified: report.spfVerified,
        dmarcVerified: report.dmarcVerified,
        returnPathVerified: report.returnPathVerified,
        lastCheckedAt: new Date(),
        verifiedAt: report.isFullyVerified ? new Date() : domain.verifiedAt,
      },
    });

    return reply.status(200).send({
      id: domain.id,
      name: domain.name,
      status: newStatus.toLowerCase(),
      report,
    });
  });
}
