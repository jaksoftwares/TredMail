import { prisma, type Domain } from "@tredmail/db";
import { enqueueEmail } from "../queue/email.queue.js";
import { env, PLATFORM_ORG_SLUG } from "../config/env.js";
import { findReservedHeaders, parseFromAddress, type SendEmailInput } from "./email-validation.js";

export { sendEmailSchema } from "./email-validation.js";

const toList = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const SANDBOX_LOCAL_PART = "onboarding";

let platformOrgId: string | null = null;

/** ID of the workspace that owns TredMail's own domain, or null before the seed has run. */
export async function getPlatformOrganizationId(): Promise<string | null> {
  if (platformOrgId) return platformOrgId;
  const org = await prisma.organization.findUnique({ where: { slug: PLATFORM_ORG_SLUG }, select: { id: true } });
  platformOrgId = org?.id ?? null;
  return platformOrgId;
}

type Failure = { ok: false; statusCode: number; error: string; message: string };

/**
 * Finds the verified domain a message may be sent from.
 *
 * Workspaces send from their own verified domains. Before they have one, they may use the
 * shared sandbox sender (onboarding@<platform domain>), limited to their own members'
 * verified addresses and a small daily volume, so a new user can try the API in minutes
 * without TredMail becoming an open relay.
 */
async function resolveSendingDomain(
  organizationId: string,
  sender: { address: string; domain: string },
  recipients: string[]
): Promise<{ ok: true; domain: Domain } | Failure> {
  const platformId = await getPlatformOrganizationId();
  const isPlatformDomain = sender.domain === env.PRIMARY_DOMAIN.toLowerCase();

  if (isPlatformDomain && organizationId !== platformId) {
    const domain = platformId
      ? await prisma.domain.findFirst({ where: { organizationId: platformId, name: sender.domain } })
      : null;
    if (!domain || domain.status !== "VERIFIED") {
      return { ok: false, statusCode: 503, error: "sandbox_unavailable", message: "The sandbox sender is not available right now." };
    }
    if (sender.address !== `${SANDBOX_LOCAL_PART}@${sender.domain}`) {
      return {
        ok: false,
        statusCode: 403,
        error: "sandbox_sender_only",
        message: `Until you verify a domain, send from '${SANDBOX_LOCAL_PART}@${sender.domain}'.`,
      };
    }

    const members = await prisma.organizationMember.findMany({
      where: { organizationId, user: { emailVerified: true } },
      select: { user: { select: { email: true } } },
    });
    const allowed = new Set(members.map((m) => m.user.email.toLowerCase()));
    const blocked = recipients.filter((address) => !allowed.has(address));
    if (blocked.length > 0) {
      return {
        ok: false,
        statusCode: 403,
        error: "sandbox_recipient_not_allowed",
        message: `The sandbox sender can only email your workspace members' verified addresses. Verify a domain to send to ${blocked[0]}.`,
      };
    }

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const sentToday = await prisma.email.count({
      where: { organizationId, domainId: domain.id, createdAt: { gte: startOfDay } },
    });
    if (sentToday >= env.SANDBOX_DAILY_LIMIT) {
      return {
        ok: false,
        statusCode: 429,
        error: "sandbox_limit_reached",
        message: `The sandbox allows ${env.SANDBOX_DAILY_LIMIT} emails per day. Verify a domain to send more.`,
      };
    }
    return { ok: true, domain };
  }

  const domain = await prisma.domain.findFirst({ where: { organizationId, name: sender.domain } });
  if (!domain) {
    return {
      ok: false,
      statusCode: 403,
      error: "domain_not_registered",
      message: `Domain '${sender.domain}' is not registered in this workspace. Add it under Domains first.`,
    };
  }
  if (domain.status !== "VERIFIED") {
    return {
      ok: false,
      statusCode: 403,
      error: "domain_not_verified",
      message: `Domain '${sender.domain}' is not verified yet. Publish its DNS records and run verification.`,
    };
  }
  return { ok: true, domain };
}

export type AcceptResult =
  | { ok: true; email: { id: string; from: string; to: string[]; createdAt: Date } }
  | Failure;

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

  const to = toList(payload.to);
  const cc = toList(payload.cc);
  const bcc = toList(payload.bcc);
  const allRecipients = [...to, ...cc, ...bcc].map((address) => address.toLowerCase());

  const resolved = await resolveSendingDomain(organizationId, sender, allRecipients);
  if (!resolved.ok) return resolved;
  const { domain } = resolved;

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
