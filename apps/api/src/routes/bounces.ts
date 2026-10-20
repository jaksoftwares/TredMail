import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticateInternal } from "../middleware/auth.js";
import { z } from "zod";
import { prisma } from "@tredmail/db";
import { dispatchWebhookEvent } from "@tredmail/core/webhooks/dispatcher";

const bouncePayloadSchema = z.object({
  email_id: z.string().optional(),
  recipient: z.string().email(),
  bounce_type: z.enum(["hard", "soft", "complaint"]).default("hard"),
  smtp_code: z.string().optional().default("550"),
  diagnostic_message: z.string().optional().default("User unknown / Address rejected"),
});

/**
 * Internal bounce and complaint receiver, called by the MTA's feedback processor.
 * Mounted at /internal/bounces and protected by INTERNAL_API_TOKEN; never public.
 */
export async function bounceRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateInternal);

  // POST /internal/bounces
  fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = bouncePayloadSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "validation_error",
        message: "Invalid bounce payload.",
      });
    }

    const { email_id, recipient, bounce_type, smtp_code, diagnostic_message } = parseResult.data;
    const cleanEmail = recipient.toLowerCase().trim();

    // 1. Locate email if email_id provided
    let emailRecord = null;
    if (email_id) {
      emailRecord = await prisma.email.findUnique({
        where: { id: email_id },
      });
    }

    // 2. If hard bounce or spam complaint, auto-insert into suppression list
    if (bounce_type === "hard" || bounce_type === "complaint") {
      const reason = bounce_type === "complaint" ? "SPAM_COMPLAINT" : "HARD_BOUNCE";
      
      // If we know the org, scope to org, otherwise scope to all orgs where this email was sent
      const orgId = emailRecord?.organizationId;
      if (orgId) {
        await prisma.suppression.upsert({
          where: {
            organizationId_email: {
              organizationId: orgId,
              email: cleanEmail,
            },
          },
          update: {
            reason,
            smtpDiagnostic: `${smtp_code}: ${diagnostic_message}`,
          },
          create: {
            organizationId: orgId,
            email: cleanEmail,
            reason,
            smtpDiagnostic: `${smtp_code}: ${diagnostic_message}`,
          },
        });
      }
    }

    // 3. Update Email record status and log event
    if (emailRecord) {
      await prisma.email.update({
        where: { id: emailRecord.id },
        data: {
          status: bounce_type === "complaint" ? "COMPLAINED" : "BOUNCED",
          smtpResponse: `${smtp_code} - ${diagnostic_message}`,
        },
      });

      await prisma.emailEvent.create({
        data: {
          emailId: emailRecord.id,
          type: bounce_type === "complaint" ? "COMPLAINED" : "BOUNCED",
          bounceType: bounce_type === "hard" ? "HARD" : bounce_type === "soft" ? "SOFT" : "SPAM_COMPLAINT",
          details: {
            smtp_code,
            diagnostic_message,
          },
        },
      });

      // 4. Trigger Webhook
      dispatchWebhookEvent(emailRecord.organizationId, bounce_type === "complaint" ? "email.complained" : "email.bounced", {
        email_id: emailRecord.id,
        recipient: cleanEmail,
        bounce_type,
        smtp_code,
        diagnostic: diagnostic_message,
      }).catch((err) => request.log.warn({ err }, "bounce webhook dispatch failed"));
    }

    return reply.status(200).send({
      success: true,
      message: `Processed ${bounce_type} bounce for ${cleanEmail}`,
    });
  });
}
