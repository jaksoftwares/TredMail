import { prisma, type Domain } from "@tredmail/db";
import { enqueueEmail, removeQueuedEmail } from "../queue/email.queue.js";
import { renderTemplate } from "../mail/template-engine.js";
import { releaseUsage, reserveUsage } from "../billing/usage.js";
import { env, PLATFORM_ORG_SLUG } from "../config/env.js";
import { findReservedHeaders, MAX_SCHEDULE_DAYS, parseFromAddress, type SendEmailInput } from "./email-validation.js";

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
  | {
      ok: true;
      email: { id: string; from: string; to: string[]; status: "queued" | "scheduled"; scheduledAt: Date | null; createdAt: Date };
    }
  | Failure;

const fail = (statusCode: number, error: string, message: string): Failure => ({ ok: false, statusCode, error, message });

/** Finds a workspace template by id or alias. */
export async function findTemplate(organizationId: string, idOrAlias: string) {
  return prisma.template.findFirst({
    where: { organizationId, OR: [{ id: idOrAlias }, { alias: idOrAlias.toLowerCase() }] },
  });
}

interface ResolvedContent {
  ok: true;
  from?: string;
  replyTo?: string;
  subject?: string;
  html?: string;
  text?: string;
  templateId: string | null;
}

/** Applies a template to the request. Fields given in the request win over the template's. */
async function resolveContent(organizationId: string, payload: SendEmailInput): Promise<ResolvedContent | Failure> {
  if (!payload.template) {
    return { ok: true, from: payload.from, replyTo: payload.reply_to, subject: payload.subject, html: payload.html, text: payload.text, templateId: null };
  }
  const template = await findTemplate(organizationId, payload.template);
  if (!template) return fail(404, "template_not_found", `Template '${payload.template}' does not exist in this workspace.`);
  const rendered = renderTemplate(
    { subject: payload.subject ?? template.subject, html: payload.html ?? template.html, text: payload.text ?? template.text },
    payload.variables ?? {},
  );
  if (rendered.missing.length > 0) {
    return fail(422, "missing_template_variables", `Provide these template variables (or give them a fallback): ${rendered.missing.join(", ")}.`);
  }
  return {
    ok: true,
    from: payload.from ?? template.from ?? undefined,
    replyTo: payload.reply_to ?? template.replyTo ?? undefined,
    subject: rendered.subject,
    html: rendered.html ?? undefined,
    text: rendered.text ?? undefined,
    templateId: template.id,
  };
}

function parseSchedule(value: string | undefined): { ok: true; at: Date | null } | Failure {
  if (!value) return { ok: true, at: null };
  const at = new Date(value);
  const now = Date.now();
  if (at.getTime() <= now + 5_000) return { ok: true, at: null }; // now or in the past: send immediately
  if (at.getTime() > now + MAX_SCHEDULE_DAYS * 86_400_000) {
    return fail(422, "schedule_too_far", `scheduled_at can be at most ${MAX_SCHEDULE_DAYS} days ahead.`);
  }
  return { ok: true, at };
}

/**
 * Validates sender domain and suppressions, records the email (with its attachments) and
 * queues it for delivery, now or at scheduled_at. Shared by the API, batch sends and the
 * SMTP relay so every path applies the same rules.
 */
export async function acceptEmail(organizationId: string, payload: SendEmailInput): Promise<AcceptResult> {
  const content = await resolveContent(organizationId, payload);
  if (!content.ok) return content;
  if (!content.from) return fail(422, "missing_from", "Provide 'from' (or set a default sender on the template).");
  if (!content.subject) return fail(422, "missing_subject", "Provide 'subject' (or use a template that has one).");
  if (!content.html && !content.text) return fail(422, "missing_body", "Provide 'html', 'text' or both.");

  const reserved = findReservedHeaders(payload.headers);
  if (reserved.length > 0) {
    return fail(422, "reserved_header", `These headers are set by TredMail and cannot be overridden: ${reserved.join(", ")}.`);
  }

  const sender = parseFromAddress(content.from);
  if (!sender) return fail(422, "invalid_from", `Invalid 'from' address: '${content.from}'.`);

  const schedule = parseSchedule(payload.scheduled_at);
  if (!schedule.ok) return schedule;

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
    return fail(
      422,
      "recipient_suppressed",
      `Recipient '${suppressed.email}' is suppressed (${suppressed.reason}). Delivery was blocked to protect your sender reputation.`,
    );
  }

  const standing = await sendingStanding(organizationId);
  if (!standing.ok) return standing;

  // Count the recipients against the plan's limits last, so refused requests use nothing.
  const usage = await reserveUsage(organizationId, allRecipients.length);
  if (!usage.ok) return usage;

  const attachments = (payload.attachments ?? []).map((a) => {
    const bytes = Buffer.from(a.content, "base64");
    return { filename: a.filename, contentType: a.content_type, contentId: a.content_id, content: bytes, size: bytes.length };
  });

  const scheduledAt = schedule.at;
  const email = await prisma
    .$transaction(async (tx) => {
    const created = await tx.email.create({
      data: {
        organizationId,
        domainId: domain.id,
        from: content.from!,
        to,
        cc,
        bcc,
        replyTo: content.replyTo,
        subject: content.subject!,
        htmlBody: content.html,
        textBody: content.text,
        status: scheduledAt ? "SCHEDULED" : "QUEUED",
        scheduledAt,
        templateId: content.templateId,
        trackOpens: payload.track_opens ?? true,
        trackClicks: payload.track_clicks ?? true,
        metadata: payload.headers ? { headers: payload.headers } : undefined,
        tags: payload.tags,
        attachments: attachments.length ? { create: attachments } : undefined,
      },
    });
    await tx.emailEvent.create({
      data: {
        emailId: created.id,
        type: scheduledAt ? "SCHEDULED" : "QUEUED",
        details: scheduledAt ? { scheduledAt: scheduledAt.toISOString() } : undefined,
      },
    });
    return created;
    })
    .catch(async (err) => {
      await releaseUsage(organizationId, allRecipients.length, usage.day);
      throw err;
    });

  // The database row is the source of truth. If Redis is briefly unavailable, the worker's
  // outbox sweeper queues the email within a minute, so the request still succeeds.
  try {
    await enqueueEmail({ emailId: email.id, organizationId, domainId: domain.id }, scheduledAt);
  } catch (err) {
    console.error(`[email] could not queue ${email.id} now; the outbox sweeper will retry`, err);
  }

  return {
    ok: true,
    email: {
      id: email.id,
      from: email.from,
      to: email.to,
      status: scheduledAt ? "scheduled" : "queued",
      scheduledAt: email.scheduledAt,
      createdAt: email.createdAt,
    },
  };
}

/** Suspended workspaces (staff action) and paused ones (circuit breaker) cannot send. */
async function sendingStanding(organizationId: string): Promise<{ ok: true } | Failure> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { suspendedAt: true, sendingPausedAt: true, sendingPauseReason: true },
  });
  if (org?.suspendedAt) {
    return fail(403, "workspace_suspended", "This workspace is suspended. Contact Dovepeak Technologies support.");
  }
  if (org?.sendingPausedAt) {
    return fail(403, "sending_paused", `Sending is paused for this workspace: ${org.sendingPauseReason ?? "unusual bounce or complaint rates"}. Contact support to resume.`);
  }
  return { ok: true };
}

/** Cancels a scheduled email. Once an email is being sent it can no longer be canceled. */
export async function cancelScheduledEmail(organizationId: string, emailId: string): Promise<{ ok: true } | Failure> {
  const updated = await prisma.email.updateMany({
    where: { id: emailId, organizationId, status: "SCHEDULED" },
    data: { status: "CANCELED" },
  });
  if (updated.count === 0) {
    const email = await prisma.email.findFirst({ where: { id: emailId, organizationId }, select: { status: true } });
    if (!email) return fail(404, "not_found", `Email '${emailId}' not found.`);
    return fail(409, "not_cancelable", `Only scheduled emails can be canceled; this one is ${email.status.toLowerCase()}.`);
  }
  await prisma.emailEvent.create({ data: { emailId, type: "CANCELED" } });
  // A canceled email is never sent, so it does not count towards the plan's usage
  const canceled = await prisma.email.findUnique({ where: { id: emailId }, select: { to: true, cc: true, bcc: true, createdAt: true } });
  if (canceled) await releaseUsage(organizationId, canceled.to.length + canceled.cc.length + canceled.bcc.length, canceled.createdAt);
  // The worker also skips canceled rows, so a failure here is harmless.
  await removeQueuedEmail(emailId).catch(() => undefined);
  return { ok: true };
}

/** Moves a scheduled email to a new time, or sends it now when the time is not in the future. */
export async function rescheduleEmail(
  organizationId: string,
  emailId: string,
  scheduledAtInput: string,
): Promise<{ ok: true; scheduledAt: Date | null } | Failure> {
  const schedule = parseSchedule(scheduledAtInput);
  if (!schedule.ok) return schedule;
  const email = await prisma.email.findFirst({ where: { id: emailId, organizationId } });
  if (!email) return fail(404, "not_found", `Email '${emailId}' not found.`);
  if (email.status !== "SCHEDULED") {
    return fail(409, "not_reschedulable", `Only scheduled emails can be rescheduled; this one is ${email.status.toLowerCase()}.`);
  }
  const at = schedule.at;
  await prisma.email.update({ where: { id: emailId }, data: { scheduledAt: at, status: at ? "SCHEDULED" : "QUEUED" } });
  await prisma.emailEvent.create({
    data: {
      emailId,
      type: at ? "SCHEDULED" : "QUEUED",
      details: at ? { scheduledAt: at.toISOString(), rescheduled: true } : { rescheduled: true },
    },
  });
  await removeQueuedEmail(emailId).catch(() => undefined);
  await enqueueEmail({ emailId, organizationId, domainId: email.domainId }, at).catch((err) =>
    console.error(`[email] could not requeue ${emailId}; the outbox sweeper will retry`, err),
  );
  return { ok: true, scheduledAt: at };
}
