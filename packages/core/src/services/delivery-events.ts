import { prisma, type EmailStatus, type Prisma } from "@tredmail/db";
import { dispatchWebhookEvent } from "../webhooks/dispatcher.js";
import { classifyFailure, type FailureClassification } from "../mail/bounce-classifier.js";

/**
 * Applies what happened to an email after TredMail handed it to the mail server: delivered,
 * delayed, bounced, expired or complained about. Fed by KumoMTA's delivery log, by bounce
 * and complaint reports that come back by email, and by the internal bounce endpoint.
 *
 * An email can have several recipients, so its status is the *worst* outcome seen: a later
 * delivery to one recipient never hides a bounce or complaint from another.
 */

const STATUS_RANK: Record<EmailStatus, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  FAILED: 4,
  BOUNCED: 5,
  COMPLAINED: 6,
};

export type EventSource = "mta_log" | "dsn" | "arf" | "internal_api";

interface Base {
  emailId: string;
  recipient?: string;
  source: EventSource;
  /** Identifies the source record (e.g. KumoMTA's record id) so retried posts are ignored. */
  dedupeKey?: string;
  at?: Date;
  details?: Prisma.InputJsonObject;
}

type EmailRow = { id: string; organizationId: string; status: EmailStatus; from: string; to: string[]; cc: string[]; bcc: string[]; subject: string };

async function loadEmail(emailId: string): Promise<EmailRow | null> {
  return prisma.email.findUnique({
    where: { id: emailId },
    select: { id: true, organizationId: true, status: true, from: true, to: true, cc: true, bcc: true, subject: true },
  });
}

async function alreadyRecorded(emailId: string, dedupeKey: string | undefined): Promise<boolean> {
  if (!dedupeKey) return false;
  const existing = await prisma.emailEvent.findFirst({
    where: { emailId, details: { path: ["dedupeKey"], equals: dedupeKey } },
    select: { id: true },
  });
  return existing !== null;
}

/** The single recipient of an email, when a report does not say which address it is about. */
function soleRecipient(email: EmailRow): string | undefined {
  const all = [...email.to, ...email.cc, ...email.bcc];
  return all.length === 1 ? all[0].toLowerCase() : undefined;
}

function isRecipientOf(email: EmailRow, address: string): boolean {
  const lower = address.toLowerCase();
  return [...email.to, ...email.cc, ...email.bcc].some((r) => r.toLowerCase() === lower);
}

async function applyStatus(email: EmailRow, status: EmailStatus, extra: Prisma.EmailUpdateInput = {}) {
  if (STATUS_RANK[status] <= STATUS_RANK[email.status]) {
    if (Object.keys(extra).length > 0) await prisma.email.update({ where: { id: email.id }, data: extra });
    return;
  }
  await prisma.email.update({ where: { id: email.id }, data: { status, ...extra } });
}

const fireWebhook = (email: EmailRow, event: Parameters<typeof dispatchWebhookEvent>[1], payload: Record<string, unknown>) =>
  dispatchWebhookEvent(email.organizationId, event, {
    email_id: email.id,
    from: email.from,
    to: email.to,
    subject: email.subject,
    ...payload,
  }).catch((err) => console.error(`[delivery] ${event} webhook failed`, err));

async function suppress(organizationId: string, address: string, reason: "HARD_BOUNCE" | "SPAM_COMPLAINT", diagnostic: string) {
  await prisma.suppression.upsert({
    where: { organizationId_email: { organizationId, email: address } },
    update: { reason, smtpDiagnostic: diagnostic.slice(0, 2000) },
    create: { organizationId, email: address, reason, smtpDiagnostic: diagnostic.slice(0, 2000) },
  });
}

export async function recordDelivered(input: Base & { response?: string }): Promise<boolean> {
  const email = await loadEmail(input.emailId);
  if (!email || (await alreadyRecorded(email.id, input.dedupeKey))) return false;
  const at = input.at ?? new Date();

  await prisma.emailEvent.create({
    data: {
      emailId: email.id,
      type: "DELIVERED",
      timestamp: at,
      details: { ...input.details, recipient: input.recipient, response: input.response, source: input.source, dedupeKey: input.dedupeKey },
    },
  });
  await applyStatus(email, "DELIVERED", email.status === "DELIVERED" ? {} : { deliveredAt: at, smtpResponse: input.response });
  fireWebhook(email, "email.delivered", { recipient: input.recipient, smtp_response: input.response, delivered_at: at.toISOString() });
  return true;
}

export async function recordDeferred(input: Base & { response?: string; attempt?: number }): Promise<boolean> {
  const email = await loadEmail(input.emailId);
  if (!email || (await alreadyRecorded(email.id, input.dedupeKey))) return false;

  await prisma.emailEvent.create({
    data: {
      emailId: email.id,
      type: "DEFERRED",
      timestamp: input.at ?? new Date(),
      details: {
        ...input.details,
        recipient: input.recipient,
        response: input.response,
        attempt: input.attempt,
        source: input.source,
        dedupeKey: input.dedupeKey,
      },
    },
  });
  fireWebhook(email, "email.deferred", { recipient: input.recipient, smtp_response: input.response, attempt: input.attempt });
  return true;
}

export interface BounceInput extends Base {
  status?: string;
  smtpCode?: number;
  diagnostic?: string;
  mtaClassification?: string;
  /** Overrides the classifier, e.g. the internal endpoint's explicit "hard"/"soft". */
  classification?: FailureClassification;
}

/**
 * A permanent failure (or a temporary one reported after the fact by a DSN). Hard failures
 * that prove the address is bad suppress the recipient for the email's workspace.
 */
export async function recordBounce(input: BounceInput): Promise<boolean> {
  const email = await loadEmail(input.emailId);
  if (!email || (await alreadyRecorded(email.id, input.dedupeKey))) return false;

  const recipient = input.recipient?.toLowerCase() ?? soleRecipient(email);
  // A report naming an address this email was never sent to is ignored rather than trusted.
  if (recipient && !isRecipientOf(email, recipient) && input.source !== "mta_log") return false;

  const classification =
    input.classification ??
    classifyFailure({ status: input.status, smtpCode: input.smtpCode, diagnostic: input.diagnostic, mtaClassification: input.mtaClassification });
  const diagnostic = [input.status, input.diagnostic].filter(Boolean).join(" ") || "Delivery failed";

  if (!classification.permanent) {
    return recordDeferred({ ...input, recipient, response: diagnostic });
  }

  await prisma.emailEvent.create({
    data: {
      emailId: email.id,
      type: "BOUNCED",
      timestamp: input.at ?? new Date(),
      bounceType: classification.suppress ? "HARD" : "SOFT",
      details: {
        ...input.details,
        recipient,
        status: input.status,
        smtpCode: input.smtpCode,
        diagnostic: input.diagnostic,
        category: classification.category,
        suppressed: classification.suppress && !!recipient,
        source: input.source,
        dedupeKey: input.dedupeKey,
      },
    },
  });
  if (classification.suppress && recipient) {
    await suppress(email.organizationId, recipient, "HARD_BOUNCE", diagnostic);
  }
  await applyStatus(email, "BOUNCED", { smtpResponse: diagnostic.slice(0, 2000) });
  fireWebhook(email, "email.bounced", {
    recipient,
    bounce_type: classification.suppress ? "hard" : "soft",
    category: classification.category,
    smtp_status: input.status,
    diagnostic: input.diagnostic,
    suppressed: classification.suppress && !!recipient,
  });
  return true;
}

/** The mail server gave up after retrying temporary failures for the full retry window. */
export async function recordExpired(input: Base & { response?: string }): Promise<boolean> {
  const email = await loadEmail(input.emailId);
  if (!email || (await alreadyRecorded(email.id, input.dedupeKey))) return false;

  await prisma.emailEvent.create({
    data: {
      emailId: email.id,
      type: "FAILED",
      timestamp: input.at ?? new Date(),
      details: { ...input.details, recipient: input.recipient, response: input.response, source: input.source, dedupeKey: input.dedupeKey },
    },
  });
  await applyStatus(email, "FAILED", { smtpResponse: input.response?.slice(0, 2000) });
  fireWebhook(email, "email.failed", { recipient: input.recipient, error: input.response ?? "Delivery expired after retries" });
  return true;
}

/** A recipient marked the email as spam. Always suppresses that recipient. */
export async function recordComplaint(input: Base & { feedbackType?: string }): Promise<boolean> {
  const email = await loadEmail(input.emailId);
  if (!email || (await alreadyRecorded(email.id, input.dedupeKey))) return false;

  // Microsoft and others redact the recipient; fall back to the email's only recipient.
  const named = input.recipient?.toLowerCase();
  const recipient = named && isRecipientOf(email, named) ? named : soleRecipient(email);

  await prisma.emailEvent.create({
    data: {
      emailId: email.id,
      type: "COMPLAINED",
      timestamp: input.at ?? new Date(),
      bounceType: "SPAM_COMPLAINT",
      details: { ...input.details, recipient, feedbackType: input.feedbackType, source: input.source, dedupeKey: input.dedupeKey },
    },
  });
  if (recipient) await suppress(email.organizationId, recipient, "SPAM_COMPLAINT", `Spam complaint (${input.feedbackType ?? "abuse"})`);
  await applyStatus(email, "COMPLAINED");
  fireWebhook(email, "email.complained", { recipient, feedback_type: input.feedbackType ?? "abuse" });
  return true;
}
