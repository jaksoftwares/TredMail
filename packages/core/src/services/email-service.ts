import { prisma } from "@tredmail/db";
import { enqueueEmail } from "../queue/email.queue.js";
import { findReservedHeaders, parseFromAddress, type SendEmailInput } from "./email-validation.js";

export { sendEmailSchema } from "./email-validation.js";

const toList = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export type AcceptResult =
  | { ok: true; email: { id: string; from: string; to: string[]; createdAt: Date } }
  | { ok: false; statusCode: number; error: string; message: string };

/**
 * Validates sender domain and suppressions, records the email and enqueues it for delivery.
 * Shared by the single-send and batch endpoints so both apply the same rules.
 */
export async function acceptEmail(organizationId: string, payload: SendEmailInput): Promise<AcceptResult> {
  if (!payload.html && !payload.text) {
    return { ok: false, statusCode: 422, error: "missing_body", message: "Provide 'html', 'text' or both." };
  }

  const reserved = findReservedHeaders(payload.headers);
  if (reserved.length > 0) {
    return {
      ok: false,
      statusCode: 422,
      error: "reserved_header",
      message: `These headers are set by TredMail and cannot be overridden: ${reserved.join(", ")}.`,
    };
  }

  const sender = parseFromAddress(payload.from);
  if (!sender) {
    return { ok: false, statusCode: 422, error: "invalid_from", message: `Invalid 'from' address: '${payload.from}'.` };
  }

  const domain = await prisma.domain.findFirst({ where: { organizationId, name: sender.domain } });
  if (!domain) {
    return {
      ok: false,
      statusCode: 403,
      error: "domain_not_registered",
      message: `Domain '${sender.domain}' is not registered under your account. Register it via POST /v1/domains first.`,
    };
  }
  if (domain.status !== "VERIFIED") {
    return {
      ok: false,
      statusCode: 403,
      error: "domain_not_verified",
      message: `Domain '${sender.domain}' is not yet verified. Complete DNS authentication in the TredMail console.`,
    };
  }

  const to = toList(payload.to);
  const cc = toList(payload.cc);
  const bcc = toList(payload.bcc);
  const allRecipients = [...to, ...cc, ...bcc].map((address) => address.toLowerCase());

  const suppressed = await prisma.suppression.findFirst({
    where: { organizationId, email: { in: allRecipients } },
  });
  if (suppressed) {
    return {
      ok: false,
      statusCode: 422,
      error: "recipient_suppressed",
      message: `Recipient '${suppressed.email}' is suppressed (${suppressed.reason}). Delivery was blocked to protect your sender reputation.`,
    };
  }

  const email = await prisma.$transaction(async (tx) => {
    const created = await tx.email.create({
      data: {
        organizationId,
        domainId: domain.id,
        from: payload.from,
        to,
        cc,
        bcc,
        replyTo: payload.reply_to,
        subject: payload.subject,
        htmlBody: payload.html,
        textBody: payload.text,
        status: "QUEUED",
        metadata: payload.headers ? { headers: payload.headers } : undefined,
        tags: payload.tags,
      },
    });
    await tx.emailEvent.create({ data: { emailId: created.id, type: "QUEUED" } });
    return created;
  });

  try {
    await enqueueEmail({
      emailId: email.id,
      organizationId,
      domainId: domain.id,
      from: payload.from,
      to,
      cc,
      bcc,
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
      trackOpens: payload.track_opens ?? true,
      trackClicks: payload.track_clicks ?? true,
    });
  } catch (err) {
    // Until the transactional outbox lands (Phase 3), never leave a row stuck in QUEUED.
    await prisma.email.update({ where: { id: email.id }, data: { status: "FAILED", smtpResponse: "enqueue_failed" } });
    await prisma.emailEvent.create({
      data: { emailId: email.id, type: "FAILED", details: { reason: "enqueue_failed" } },
    });
    throw err;
  }

  return { ok: true, email: { id: email.id, from: email.from, to: email.to, createdAt: email.createdAt } };
}
