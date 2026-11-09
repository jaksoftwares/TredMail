import { prisma, type Domain } from "@tredmail/db";
import { enqueueEmail, removeQueuedEmail } from "../queue/email.queue.js";
import { SENDABLE_DOMAIN_STATUSES } from "../delivery/attempts.js";
import { renderTemplate } from "../mail/template-engine.js";
import { releaseUsage, reserveUsage } from "../billing/usage.js";
import { env, PLATFORM_ORG_SLUG } from "../config/env.js";
import { dispatchWebhookEvent } from "../webhooks/dispatcher.js";
import {
  checkListUnsubscribeHeaders,
  findReservedHeaders,
  MAX_SCHEDULE_DAYS,
  parseFromAddress,
  withoutSuppressed,
  type SendEmailInput,
} from "./email-validation.js";

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
    if (!domain || !SENDABLE_DOMAIN_STATUSES.has(domain.status)) {
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
  // DEGRADED: a recent re-check failed but the domain still sends (the worker holds the same set)
  if (!SENDABLE_DOMAIN_STATUSES.has(domain.status)) {
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
      email: {
        id: string;
        from: string;
        to: string[];
        status: "queued" | "scheduled" | "delivered";
        /** Test mode (tred_test_ key): recorded and reported as delivered, never sent */
        test: boolean;
        scheduledAt: Date | null;
        createdAt: Date;
        /** Recipients left out because they are on the workspace's suppression list */
        suppressed: string[];
      };
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
  if (Number.isNaN(at.getTime())) return fail(422, "invalid_scheduled_at", `scheduled_at must be an ISO 8601 time, got '${value}'.`);
  const now = Date.now();
  if (at.getTime() <= now + 5_000) return { ok: true, at: null }; // now or in the past: send immediately
  if (at.getTime() > now + MAX_SCHEDULE_DAYS * 86_400_000) {
    return fail(422, "schedule_too_far", `scheduled_at can be at most ${MAX_SCHEDULE_DAYS} days ahead.`);
  }
  return { ok: true, at };
}

export interface AcceptOptions {
  /**
   * SYSTEM: TredMail's own mail (system-mailer.ts). It goes to the system queue, skips the
   * warm-up cap and does not count against the platform workspace's plan.
   */
  priority?: "NORMAL" | "SYSTEM";
  /**
   * Test mode (a `tred_test_` key): the email is validated and recorded with `isTest`, but is
   * never delivered and does not count against the plan.
   */
  testMode?: boolean;
}

/** A send that passed every check. Nothing is written until it is committed. */
export interface PreparedSend {
  organizationId: string;
  testMode: boolean;
  /** Recipients to charge against the plan (0 for system and test mail). */
  chargeable: number;
  priority: "NORMAL" | "SYSTEM";
  record: {
    domainId: string;
    from: string;
    replyTo: string | undefined;
    subject: string;
    html: string | undefined;
    text: string | undefined;
    templateId: string | null;
    to: string[];
    cc: string[];
    bcc: string[];
    removed: string[];
    scheduledAt: Date | null;
    trackOpens: boolean;
    trackClicks: boolean;
    unsubscribeLink: boolean;
    headers: Record<string, string> | undefined;
    tags: SendEmailInput["tags"];
    attachments: Array<{ filename: string; contentType: string | undefined; contentId: string | undefined; content: Buffer; size: number }>;
  };
}

/**
 * Runs every check on a send without writing anything: content, headers, sender domain,
 * suppressions and workspace standing. The SMTP relay runs it for every part of a message
 * before accepting any of them.
 */
export async function prepareSend(
  organizationId: string,
  payload: SendEmailInput,
  options: AcceptOptions = {},
): Promise<{ ok: true; prepared: PreparedSend } | Failure> {
  const priority = options.priority ?? "NORMAL";
  const testMode = options.testMode === true;
  const content = await resolveContent(organizationId, payload);
  if (!content.ok) return content;
  if (!content.from) return fail(422, "missing_from", "Provide 'from' (or set a default sender on the template).");
  if (!content.subject) return fail(422, "missing_subject", "Provide 'subject' (or use a template that has one).");
  if (!content.html && !content.text) return fail(422, "missing_body", "Provide 'html', 'text' or both.");

  const reserved = findReservedHeaders(payload.headers);
  if (reserved.length > 0) {
    return fail(422, "reserved_header", `These headers are set by TredMail and cannot be overridden: ${reserved.join(", ")}.`);
  }
  const headerProblem = checkListUnsubscribeHeaders(payload.headers, payload.unsubscribe === true);
  if (headerProblem) return fail(422, "invalid_unsubscribe_header", headerProblem);

  const sender = parseFromAddress(content.from);
  if (!sender) return fail(422, "invalid_from", `Invalid 'from' address: '${content.from}'.`);

  const schedule = parseSchedule(payload.scheduled_at);
  if (!schedule.ok) return schedule;

  const requested = { to: toList(payload.to), cc: toList(payload.cc), bcc: toList(payload.bcc) };
  const requestedAll = [...requested.to, ...requested.cc, ...requested.bcc].map((address) => address.toLowerCase());

  const suppressedRows = await prisma.suppression.findMany({
    where: { organizationId, email: { in: requestedAll } },
    select: { email: true, reason: true },
  });
  const { to, cc, bcc, removed } = withoutSuppressed(requested, new Set(suppressedRows.map((r) => r.email.toLowerCase())));
  const allRecipients = [...to, ...cc, ...bcc].map((address) => address.toLowerCase());
  if (allRecipients.length === 0) {
    const first = suppressedRows[0];
    return fail(
      422,
      "recipient_suppressed",
      requestedAll.length === 1
        ? `Recipient '${first.email}' is suppressed (${first.reason}). Delivery was blocked to protect your sender reputation.`
        : `All ${requestedAll.length} recipients are suppressed (for example '${first.email}': ${first.reason}). Nothing was sent.`,
    );
  }
  // A one-click unsubscribe link must identify one person: the header is the same for every recipient
  if (payload.unsubscribe && allRecipients.length !== 1) {
    return fail(422, "unsubscribe_needs_single_recipient", "unsubscribe: true needs exactly one recipient. Send one email per recipient.");
  }

  const resolved = await resolveSendingDomain(organizationId, sender, allRecipients);
  if (!resolved.ok) return resolved;
  const { domain } = resolved;

  const standing = await sendingStanding(organizationId);
  if (!standing.ok) return standing;

  const attachments = (payload.attachments ?? []).map((a) => {
    const bytes = Buffer.from(a.content, "base64");
    return { filename: a.filename, contentType: a.content_type, contentId: a.content_id, content: bytes, size: bytes.length };
  });

  return {
    ok: true,
    prepared: {
      organizationId,
      testMode,
      priority,
      // Test and system mail do not count against the plan; everything else counts per recipient
      chargeable: testMode || priority === "SYSTEM" ? 0 : allRecipients.length,
      record: {
        domainId: domain.id,
        from: content.from,
        replyTo: content.replyTo,
        subject: content.subject,
        html: content.html,
        text: content.text,
        templateId: content.templateId,
        to,
        cc,
        bcc,
        removed,
        scheduledAt: schedule.at,
        // Tracking is off unless the request or the workspace's defaults turn it on
        trackOpens: payload.track_opens ?? standing.trackOpensDefault,
        trackClicks: payload.track_clicks ?? standing.trackClicksDefault,
        unsubscribeLink: payload.unsubscribe === true,
        headers: payload.headers,
        tags: payload.tags,
        attachments,
      },
    },
  };
}

/**
 * Records a prepared send and queues it. Usage must already be reserved for `chargeable`
 * recipients (see acceptEmail). Test mail is recorded as delivered and never queued.
 */
export async function commitSend(prepared: PreparedSend): Promise<Extract<AcceptResult, { ok: true }>> {
  const { organizationId, testMode, priority, record } = prepared;
  const scheduledAt = record.scheduledAt;
  const email = await prisma.$transaction(async (tx) => {
    const created = await tx.email.create({
      data: {
        organizationId,
        domainId: record.domainId,
        from: record.from,
        to: record.to,
        cc: record.cc,
        bcc: record.bcc,
        replyTo: record.replyTo,
        subject: record.subject,
        htmlBody: record.html,
        textBody: record.text,
        status: testMode ? "DELIVERED" : scheduledAt ? "SCHEDULED" : "QUEUED",
        deliveredAt: testMode ? new Date() : null,
        isTest: testMode,
        scheduledAt,
        templateId: record.templateId,
        priority,
        trackOpens: record.trackOpens,
        trackClicks: record.trackClicks,
        unsubscribeLink: record.unsubscribeLink,
        metadata: record.headers ? { headers: record.headers } : undefined,
        tags: record.tags,
        attachments: record.attachments.length ? { create: record.attachments } : undefined,
      },
    });
    await tx.emailEvent.create({
      data: {
        emailId: created.id,
        type: testMode ? "TEST_MODE" : scheduledAt ? "SCHEDULED" : "QUEUED",
        details: {
          ...(scheduledAt && !testMode ? { scheduledAt: scheduledAt.toISOString() } : {}),
          ...(record.removed.length ? { suppressed: record.removed } : {}),
        },
      },
    });
    return created;
  });

  if (!testMode) {
    // The database row is the source of truth. If Redis is briefly unavailable, the worker's
    // outbox sweeper queues the email within a minute, so the request still succeeds.
    try {
      await enqueueEmail({ emailId: email.id, organizationId, domainId: record.domainId }, scheduledAt, priority);
    } catch (err) {
      console.error(`[email] could not queue ${email.id} now; the outbox sweeper will retry`, err);
    }
  }

  return {
    ok: true,
    email: {
      id: email.id,
      from: email.from,
      to: email.to,
      status: testMode ? "delivered" : scheduledAt ? "scheduled" : "queued",
      scheduledAt: email.scheduledAt,
      createdAt: email.createdAt,
      suppressed: record.removed,
      test: testMode,
    },
  };
}

/**
 * Validates sender domain and suppressions, records the email (with its attachments) and
 * queues it for delivery, now or at scheduled_at. Shared by the API, batch sends and the
 * SMTP relay so every path applies the same rules.
 *
 * Suppressed recipients are removed and listed in the result (`suppressed`); the email is
 * refused only when no recipient is left.
 */
export async function acceptEmail(organizationId: string, payload: SendEmailInput, options: AcceptOptions = {}): Promise<AcceptResult> {
  const checked = await prepareSend(organizationId, payload, options);
  if (!checked.ok) return checked;
  const { prepared } = checked;

  // Count the recipients against the plan's limits last, so refused requests use nothing.
  let day: Date | null = null;
  if (prepared.chargeable > 0) {
    const usage = await reserveUsage(organizationId, prepared.chargeable);
    if (!usage.ok) return usage;
    day = usage.day;
  }
  try {
    return await commitSend(prepared);
  } catch (err) {
    if (day) await releaseUsage(organizationId, prepared.chargeable, day);
    throw err;
  }
}

/**
 * Records a message part that was refused as a FAILED email, so it shows in the console and fires
 * email.failed. An email belongs to a registered domain, so this needs the sender's domain to be
 * registered in the workspace; otherwise the refusal is only logged.
 */
export async function recordRefusedEmail(
  organizationId: string,
  payload: SendEmailInput,
  reason: { error: string; message: string },
  options: AcceptOptions = {},
): Promise<boolean> {
  const sender = payload.from ? parseFromAddress(payload.from) : null;
  const domain = sender ? await prisma.domain.findFirst({ where: { organizationId, name: sender.domain } }) : null;
  if (!domain || !payload.from) {
    console.warn(`[email] refused message not recorded (sender domain not registered): ${reason.error}`);
    return false;
  }
  const from = payload.from;
  const email = await prisma.$transaction(async (tx) => {
    const created = await tx.email.create({
      data: {
        organizationId,
        domainId: domain.id,
        from,
        to: toList(payload.to),
        cc: toList(payload.cc),
        bcc: toList(payload.bcc),
        subject: payload.subject ?? "(no subject)",
        htmlBody: payload.html,
        textBody: payload.text,
        status: "FAILED",
        smtpResponse: `${reason.error}: ${reason.message}`.slice(0, 2000),
        priority: options.priority ?? "NORMAL",
        isTest: options.testMode === true,
      },
    });
    await tx.emailEvent.create({
      data: { emailId: created.id, type: "FAILED", details: { error: reason.error, message: reason.message } },
    });
    return created;
  });
  await dispatchWebhookEvent(organizationId, "email.failed", {
    email_id: email.id,
    from: email.from,
    to: email.to,
    subject: email.subject,
    error: reason.error,
    reason: reason.message,
    ...(options.testMode ? { test: true } : {}),
  }).catch((err) => console.error("[email] email.failed webhook failed", err));
  return true;
}

/**
 * Suspended workspaces (staff action) and paused ones (circuit breaker) cannot send. Also
 * returns the workspace's tracking defaults.
 */
async function sendingStanding(organizationId: string): Promise<{ ok: true; trackOpensDefault: boolean; trackClicksDefault: boolean } | Failure> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { suspendedAt: true, sendingPausedAt: true, sendingPauseReason: true, trackOpensDefault: true, trackClicksDefault: true },
  });
  if (org?.suspendedAt) {
    return fail(403, "workspace_suspended", "This workspace is suspended. Contact Dovepeak Technologies support.");
  }
  if (org?.sendingPausedAt) {
    return fail(403, "sending_paused", `Sending is paused for this workspace: ${org.sendingPauseReason ?? "unusual bounce or complaint rates"}. Contact support to resume.`);
  }
  return { ok: true, trackOpensDefault: org?.trackOpensDefault ?? false, trackClicksDefault: org?.trackClicksDefault ?? false };
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
  await enqueueEmail({ emailId, organizationId, domainId: email.domainId }, at, email.priority).catch((err) =>
    console.error(`[email] could not requeue ${emailId}; the outbox sweeper will retry`, err),
  );
  return { ok: true, scheduledAt: at };
}
