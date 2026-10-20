import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "@tredmail/core/config/env";
import { redisConnection } from "@tredmail/core/queue/redis";
import { createVerpCodec } from "@tredmail/core/mail/verp";
import { recordBounce, recordDeferred, recordDelivered, recordExpired } from "@tredmail/core/services/delivery-events";
import { handleInboundMessage } from "@tredmail/core/services/inbound-mail";
import { authenticateInternal } from "../middleware/auth.js";

const verp = createVerpCodec(env.TREDMAIL_MASTER_ENCRYPTION_KEY);

/** The fields TredMail reads from a KumoMTA JSON log record. Unknown fields are ignored. */
const logRecordSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    sender: z.string().optional().default(""),
    recipient: z.string().optional().default(""),
    timestamp: z.union([z.number(), z.string()]).optional(),
    num_attempts: z.number().optional(),
    bounce_classification: z.string().optional(),
    site: z.string().optional(),
    egress_pool: z.string().nullish(),
    egress_source: z.string().nullish(),
    response: z
      .object({
        code: z.number().optional(),
        content: z.string().optional(),
        enhanced_code: z.object({ class: z.number(), subject: z.number(), detail: z.number() }).nullish(),
      })
      .optional(),
  })
  .passthrough();

type LogRecord = z.infer<typeof logRecordSchema>;

function toDate(timestamp: LogRecord["timestamp"]): Date | undefined {
  if (timestamp === undefined) return undefined;
  const date = typeof timestamp === "number" ? new Date(timestamp * 1000) : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function describeResponse(record: LogRecord) {
  const code = record.response?.code;
  const enhanced = record.response?.enhanced_code;
  const status = enhanced ? `${enhanced.class}.${enhanced.subject}.${enhanced.detail}` : undefined;
  const content = record.response?.content?.trim();
  const text = [code, status, content].filter((part) => part !== undefined && part !== "").join(" ");
  return { code, status, content, text };
}

/** Applies one KumoMTA log record. Returns what happened, for logging. */
async function applyLogRecord(record: LogRecord): Promise<string> {
  const emailId = verp.decode(record.sender);
  if (!emailId) return "ignored_no_verp";

  const response = describeResponse(record);
  const base = {
    emailId,
    recipient: record.recipient.toLowerCase() || undefined,
    source: "mta_log" as const,
    // One record per (message, recipient, attempt): KumoMTA retries failed hook posts.
    dedupeKey: record.id ? `${record.id}:${record.recipient.toLowerCase()}:${record.type}:${record.num_attempts ?? 0}` : undefined,
    at: toDate(record.timestamp),
    details: { site: record.site, egressPool: record.egress_pool ?? undefined, egressSource: record.egress_source ?? undefined },
  };

  switch (record.type) {
    case "Delivery":
      return (await recordDelivered({ ...base, response: response.text })) ? "delivered" : "duplicate";
    case "TransientFailure":
      return (await recordDeferred({ ...base, response: response.text, attempt: record.num_attempts })) ? "deferred" : "duplicate";
    case "Bounce":
      return (await recordBounce({
        ...base,
        status: response.status,
        smtpCode: response.code,
        diagnostic: response.content,
        mtaClassification: record.bounce_classification,
      }))
        ? "bounced"
        : "duplicate";
    case "Expiration":
    case "AdminBounce":
      return (await recordExpired({ ...base, response: response.text || record.type })) ? "expired" : "duplicate";
    default:
      return "ignored_type";
  }
}

/**
 * Internal endpoints called only by KumoMTA (INTERNAL_API_TOKEN, never routed publicly):
 *   POST /internal/mta/events   - delivery log records (JSON, one record or an array)
 *   POST /internal/mta/inbound  - a message received for a TredMail domain (message/rfc822),
 *                                 with X-Envelope-From and X-Envelope-To headers
 */
export async function mtaRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateInternal);

  fastify.addContentTypeParser(["message/rfc822", "text/plain"], { parseAs: "string" }, (_request, body, done) => done(null, body));

  fastify.post("/events", async (request, reply) => {
    const items = Array.isArray(request.body) ? request.body : [request.body];
    const results: string[] = [];
    for (const item of items) {
      const parsed = logRecordSchema.safeParse(item);
      if (!parsed.success) {
        results.push("invalid");
        continue;
      }
      results.push(await applyLogRecord(parsed.data));
    }
    request.log.debug({ results }, "mta log records applied");
    return reply.status(200).send({ results });
  });

  fastify.post("/inbound", async (request, reply) => {
    if (typeof request.body !== "string" || request.body.length === 0) {
      return reply.status(400).send({ statusCode: 400, error: "invalid_body", message: "Send the raw message as message/rfc822." });
    }
    const header = (name: string) => {
      const value = request.headers[name];
      return (Array.isArray(value) ? value[0] : value) ?? "";
    };
    const outcome = await handleInboundMessage(
      { raw: request.body, envelopeFrom: header("x-envelope-from"), envelopeTo: header("x-envelope-to") },
      redisConnection,
    );
    request.log.info({ outcome, to: header("x-envelope-to") }, "inbound message handled");
    return reply.status(200).send({ outcome });
  });
}
