import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { enqueueEmail } from "../../queue/email.queue.js";
import { authenticateApiKey } from "../middleware/auth.js";

const sendEmailSchema = z.object({
  from: z.string().min(3),
  to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
  cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  reply_to: z.string().email().optional(),
  subject: z.string().min(1),
  html: z.string().optional(),
  text: z.string().optional(),
  headers: z.record(z.string()).optional(),
  tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        content: z.string(), // base64
        content_type: z.string().optional(),
      })
    )
    .optional(),
});

/**
 * Extracts raw domain from "Name <user@domain.com>" or "user@domain.com"
 */
function extractDomain(fromHeader: string): string {
  const emailMatch = fromHeader.match(/<([^>]+)>/) || [null, fromHeader];
  const email = emailMatch[1] ? emailMatch[1].trim() : fromHeader.trim();
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : "";
}

export async function emailRoutes(fastify: FastifyInstance) {
  // Apply API key authentication to all email endpoints
  fastify.addHook("preHandler", authenticateApiKey);

  // -------------------------------------------------------------
  // POST /v1/emails - Send single email (Resend compatible)
  // -------------------------------------------------------------
  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = sendEmailSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "Invalid email payload.",
        details: parseResult.error.errors,
      });
    }

    const payload = parseResult.data;
    const orgId = request.organization!.id;

    // 1. Normalize recipients
    const toRecipients = Array.isArray(payload.to) ? payload.to : [payload.to];
    const ccRecipients = payload.cc ? (Array.isArray(payload.cc) ? payload.cc : [payload.cc]) : [];
    const bccRecipients = payload.bcc ? (Array.isArray(payload.bcc) ? payload.bcc : [payload.bcc]) : [];

    // 2. Extract and verify sending domain
    const sendingDomainName = extractDomain(payload.from);
    if (!sendingDomainName) {
      return reply.status(400).send({
        statusCode: 400,
        error: "invalid_sender",
        message: `Invalid 'from' address: '${payload.from}'.`,
      });
    }

    const domain = await prisma.domain.findFirst({
      where: {
        organizationId: orgId,
        name: sendingDomainName,
      },
    });

    if (!domain) {
      return reply.status(400).send({
        statusCode: 400,
        error: "domain_not_registered",
        message: `Domain '${sendingDomainName}' is not registered under your account. Register it via POST /v1/domains first.`,
      });
    }

    if (domain.status !== "VERIFIED") {
      return reply.status(400).send({
        statusCode: 400,
        error: "domain_not_verified",
        message: `Domain '${sendingDomainName}' is not yet verified. Please complete DNS authentication in the TredMail console.`,
      });
    }

    // 3. Suppression check (blocks addresses with hard bounces or spam complaints)
    const allRecipients = [...toRecipients, ...ccRecipients, ...bccRecipients];
    const suppressed = await prisma.suppression.findFirst({
      where: {
        organizationId: orgId,
        email: { in: allRecipients },
      },
    });

    if (suppressed) {
      return reply.status(422).send({
        statusCode: 422,
        error: "recipient_suppressed",
        message: `Recipient '${suppressed.email}' is suppressed due to previous ${suppressed.reason}. Delivery was blocked to protect your domain reputation.`,
      });
    }

    // 4. Create Email record in PostgreSQL
    const email = await prisma.email.create({
      data: {
        organizationId: orgId,
        domainId: domain.id,
        from: payload.from,
        to: toRecipients,
        cc: ccRecipients,
        bcc: bccRecipients,
        replyTo: payload.reply_to,
        subject: payload.subject,
        htmlBody: payload.html,
        textBody: payload.text,
        status: "QUEUED",
        metadata: payload.headers,
        tags: payload.tags,
      },
    });

    // 5. Log QUEUED event
    await prisma.emailEvent.create({
      data: {
        emailId: email.id,
        type: "QUEUED",
      },
    });

    // 6. Push to BullMQ Redis Queue
    await enqueueEmail({
      emailId: email.id,
      organizationId: orgId,
      domainId: domain.id,
      from: payload.from,
      to: toRecipients,
      cc: ccRecipients,
      bcc: bccRecipients,
      replyTo: payload.reply_to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      headers: payload.headers,
      attachments: payload.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.content_type,
      })),
      trackOpens: true,
      trackClicks: true,
    });

    // 7. Instant response matching Resend / Postmark
    return reply.status(200).send({
      id: email.id,
      from: email.from,
      to: email.to,
      status: "queued",
      created_at: email.createdAt.toISOString(),
    });
  });

  // -------------------------------------------------------------
  // GET /v1/emails/:id - Inspect email status & event timeline
  // -------------------------------------------------------------
  fastify.get("/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const orgId = request.organization!.id;

    const email = await prisma.email.findFirst({
      where: { id, organizationId: orgId },
      include: {
        domain: { select: { name: true } },
        events: { orderBy: { timestamp: "asc" } },
      },
    });

    if (!email) {
      return reply.status(404).send({
        statusCode: 404,
        error: "not_found",
        message: `Email '${id}' not found.`,
      });
    }

    return reply.status(200).send({
      id: email.id,
      domain: email.domain.name,
      from: email.from,
      to: email.to,
      subject: email.subject,
      status: email.status.toLowerCase(),
      created_at: email.createdAt.toISOString(),
      delivered_at: email.deliveredAt?.toISOString() || null,
      smtp_response: email.smtpResponse,
      events: email.events.map((e) => ({
        id: e.id,
        type: e.type.toLowerCase(),
        timestamp: e.timestamp.toISOString(),
        ip_address: e.ipAddress,
        user_agent: e.userAgent,
        details: e.details,
      })),
    });
  });

  // -------------------------------------------------------------
  // POST /v1/batch - Send batch emails
  // -------------------------------------------------------------
  fastify.post("/batch", async (request: FastifyRequest, reply: FastifyReply) => {
    const batchSchema = z.array(sendEmailSchema).min(1).max(100);
    const parseResult = batchSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "Expected an array of up to 100 email objects.",
      });
    }

    const emails = parseResult.data;
    const results = [];

    for (const emailData of emails) {
      // Reuse logic for each message
      const toRecipients = Array.isArray(emailData.to) ? emailData.to : [emailData.to];
      const domainName = extractDomain(emailData.from);

      const domain = await prisma.domain.findFirst({
        where: { organizationId: request.organization!.id, name: domainName },
      });

      if (!domain || domain.status !== "VERIFIED") {
        results.push({ error: `Domain ${domainName} not verified` });
        continue;
      }

      const email = await prisma.email.create({
        data: {
          organizationId: request.organization!.id,
          domainId: domain.id,
          from: emailData.from,
          to: toRecipients,
          subject: emailData.subject,
          htmlBody: emailData.html,
          textBody: emailData.text,
          status: "QUEUED",
        },
      });

      await enqueueEmail({
        emailId: email.id,
        organizationId: request.organization!.id,
        domainId: domain.id,
        from: emailData.from,
        to: toRecipients,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
      });

      results.push({ id: email.id, status: "queued" });
    }

    return reply.status(200).send({ data: results });
  });
}
