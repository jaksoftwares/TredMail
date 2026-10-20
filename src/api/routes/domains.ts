import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { generateDkimKeypair } from "../../security/dkim-keys.js";
import { encryptSecret } from "../../security/crypto.js";
import { generateExpectedDnsRecords } from "../../dns/generator.js";
import { verifyDomainDns } from "../../dns/verifier.js";
import { authenticateApiKey, requireScope } from "../middleware/auth.js";
import { env } from "../../config/env.js";

const createDomainSchema = z.object({
  name: z.string().min(3).regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Invalid domain name format"),
  region: z.string().optional().default("eu-central"),
});

export async function domainRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateApiKey);

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

    return reply.status(201).send({
      id: domain.id,
      name: domain.name,
      status: domain.status.toLowerCase(),
      records,
      created_at: domain.createdAt.toISOString(),
    });
  });

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

    const newStatus = report.isFullyVerified ? "VERIFIED" : domain.status;

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
