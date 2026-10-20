import type { Redis } from "ioredis";
import { env } from "../config/env.js";
import { createVerpCodec } from "../mail/verp.js";
import { parseInboundReport } from "../mail/report-parser.js";
import { recordBounce, recordComplaint, recordDeferred } from "./delivery-events.js";
import { acceptEmail, getPlatformOrganizationId } from "./email-service.js";

const verp = createVerpCodec(env.TREDMAIL_MASTER_ENCRYPTION_KEY);

export interface InboundMessage {
  raw: string;
  envelopeFrom: string;
  envelopeTo: string;
}

export type InboundOutcome =
  | "bounce_recorded"
  | "delay_recorded"
  | "complaint_recorded"
  | "report_unmatched"
  | "forwarded"
  | "forward_skipped"
  | "dropped";

const domainOf = (address: string) => address.trim().replace(/^<|>$/g, "").split("@")[1]?.toLowerCase() ?? "";

/**
 * Handles one message KumoMTA received for a TredMail domain:
 *  - bounce reports (DSNs) and plain-text bounces sent to a VERP address update the email;
 *  - spam complaints (ARF) suppress the recipient, wherever they arrive;
 *  - anything else addressed to the platform domain (postmaster@, abuse@, dmarc@, replies)
 *    is forwarded to OPS_EMAIL as an attachment; everything else is dropped.
 */
export async function handleInboundMessage(message: InboundMessage, redis: Redis): Promise<InboundOutcome> {
  const report = parseInboundReport(message.raw);
  const verpEmailId = verp.decode(message.envelopeTo);

  if (report.kind === "complaint") {
    const emailId = verpEmailId ?? report.originalEmailId;
    if (!emailId) return "report_unmatched";
    const ok = await recordComplaint({
      emailId,
      recipient: report.originalRecipient,
      feedbackType: report.feedbackType,
      source: "arf",
    });
    return ok ? "complaint_recorded" : "report_unmatched";
  }

  if (report.kind === "dsn") {
    const emailId = verpEmailId ?? report.originalEmailId;
    if (!emailId) return "report_unmatched";
    let outcome: InboundOutcome = "report_unmatched";
    for (const rcpt of report.recipients) {
      if (rcpt.action === "failed") {
        const ok = await recordBounce({ emailId, recipient: rcpt.recipient, status: rcpt.status, diagnostic: rcpt.diagnostic, source: "dsn" });
        if (ok) outcome = "bounce_recorded";
      } else if (rcpt.action === "delayed") {
        const ok = await recordDeferred({ emailId, recipient: rcpt.recipient, response: rcpt.diagnostic ?? rcpt.status, source: "dsn" });
        if (ok && outcome === "report_unmatched") outcome = "delay_recorded";
      }
    }
    return outcome;
  }

  if (report.kind === "unstructured_bounce") {
    // Without a DSN the failed address is unknown, so only VERP-addressed bounces are trusted.
    if (!verpEmailId) return "report_unmatched";
    const ok = await recordBounce({ emailId: verpEmailId, status: report.status, diagnostic: report.diagnostic, source: "dsn" });
    return ok ? "bounce_recorded" : "report_unmatched";
  }

  // Ordinary mail. VERP addresses only ever receive reports and auto-replies: drop them.
  if (verpEmailId || report.autoReply) return "dropped";
  if (domainOf(message.envelopeTo) !== env.PRIMARY_DOMAIN.toLowerCase()) return "dropped";
  return forwardToOps(message, report.subject, redis);
}

async function forwardToOps(message: InboundMessage, subject: string | undefined, redis: Redis): Promise<InboundOutcome> {
  if (!env.OPS_EMAIL) return "forward_skipped";
  const platformId = await getPlatformOrganizationId();
  if (!platformId) return "forward_skipped";

  const key = `tredmail:inbound-forward:${new Date().toISOString().slice(0, 10)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 2 * 24 * 3600);
  if (count > env.INBOUND_FORWARD_DAILY_LIMIT) return "forward_skipped";

  const to = message.envelopeTo.replace(/^<|>$/g, "");
  const from = message.envelopeFrom.replace(/^<|>$/g, "") || "(null sender)";
  const result = await acceptEmail(platformId, {
    from: `TredMail Postmaster <no-reply@${env.PRIMARY_DOMAIN}>`,
    to: env.OPS_EMAIL,
    subject: `[TredMail inbound] ${subject ?? "(no subject)"} (to ${to})`.slice(0, 998),
    text: [
      `TredMail received a message for ${to}.`,
      `Envelope sender: ${from}`,
      `Subject: ${subject ?? "(no subject)"}`,
      "",
      "The original message is attached (message.eml).",
    ].join("\n"),
    attachments: [{ filename: "message.eml", content: Buffer.from(message.raw).toString("base64"), content_type: "message/rfc822" }],
    track_opens: false,
    track_clicks: false,
    tags: [{ name: "category", value: "inbound-forward" }],
  });
  return result.ok ? "forwarded" : "forward_skipped";
}
