import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticateInternal } from "../middleware/auth.js";
import { z } from "zod";
import { recordBounce, recordComplaint } from "@tredmail/core/services/delivery-events";

const bouncePayloadSchema = z.object({
  email_id: z.string(),
  recipient: z.string().email(),
  bounce_type: z.enum(["hard", "soft", "complaint"]).default("hard"),
  smtp_code: z.string().optional().default("550"),
  diagnostic_message: z.string().optional().default("User unknown / Address rejected"),
});

/**
 * Manual bounce and complaint receiver for tools and operators. KumoMTA reports through
 * /internal/mta instead. Mounted at /internal/bounces, protected by INTERNAL_API_TOKEN and
 * never routed publicly.
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

    const recorded =
      bounce_type === "complaint"
        ? await recordComplaint({ emailId: email_id, recipient: cleanEmail, source: "internal_api" })
        : await recordBounce({
            emailId: email_id,
            recipient: cleanEmail,
            smtpCode: Number(smtp_code) || undefined,
            diagnostic: diagnostic_message,
            source: "internal_api",
            classification:
              bounce_type === "hard"
                ? { category: "invalid_recipient", permanent: true, suppress: true }
                : { category: "unknown", permanent: true, suppress: false },
          });

    if (!recorded) {
      return reply.status(404).send({
        statusCode: 404,
        error: "not_found",
        message: `No email '${email_id}' sent to ${cleanEmail}.`,
      });
    }
    return reply.status(200).send({
      success: true,
      message: `Processed ${bounce_type} bounce for ${cleanEmail}`,
    });
  });
}
