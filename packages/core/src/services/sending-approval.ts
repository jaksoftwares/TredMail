import { prisma } from "@tredmail/db";
import { recordAudit } from "./audit.js";
import { sendOpsAlert } from "./ops-alerts.js";

/**
 * Sending approval (H4) and the workspace limit (L3).
 *
 * A commercial workspace starts unapproved. Until staff approve it, its own domains may send only
 * UNAPPROVED_DAILY_EMAIL_LIMIT emails a day, so a new account cannot use the shared sending IP at
 * full volume before anyone has looked at it. Sandbox mail (TredMail's own domain) is unaffected.
 *
 * A user may own up to UNAPPROVED_WORKSPACE_LIMIT commercial workspaces until one of them is
 * approved, which lifts the limit for that user.
 */

export const UNAPPROVED_WORKSPACE_LIMIT = 3;

export const needsSendingApproval = (org: { isCommercial: boolean; sendingApprovedAt: Date | null }) =>
  org.isCommercial && !org.sendingApprovedAt;

export async function approveSending(organizationId: string, staffId: string) {
  const org = await prisma.organization.update({
    where: { id: organizationId },
    data: { sendingApprovedAt: new Date(), sendingReviewRequestedAt: null },
    select: { name: true },
  });
  await recordAudit({ organizationId, actorType: "staff", actorId: staffId, action: "workspace.sending_approved" });
  return { ok: true as const, name: org.name };
}

/**
 * The workspace's owner or admin asks for a review. Staff are told once per request; asking
 * again while one is open does nothing new.
 */
export async function requestSendingReview(organizationId: string, userId: string, ip?: string) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true, isCommercial: true, sendingApprovedAt: true, sendingReviewRequestedAt: true },
  });
  if (!needsSendingApproval(org)) return { ok: false as const, error: "already_approved" as const };
  if (org.sendingReviewRequestedAt) return { ok: true as const, requestedAt: org.sendingReviewRequestedAt, alreadyRequested: true };

  const requestedAt = new Date();
  await prisma.organization.update({ where: { id: organizationId }, data: { sendingReviewRequestedAt: requestedAt } });
  await recordAudit({ organizationId, actorType: "user", actorId: userId, action: "workspace.review_requested", ipAddress: ip });
  await sendOpsAlert({
    title: `Sending review requested: ${org.name}`,
    summary: "A workspace wants to send from its own domains. Check it in the back-office and approve it if it looks legitimate.",
    details: [`Workspace ${organizationId}`],
  });
  return { ok: true as const, requestedAt, alreadyRequested: false };
}

/** True when the user already owns the limit of unapproved workspaces (and none is approved). */
export async function workspaceLimitReached(userId: string): Promise<boolean> {
  const owned = await prisma.organizationMember.findMany({
    where: { userId, role: "OWNER", organization: { isCommercial: true } },
    select: { organization: { select: { sendingApprovedAt: true } } },
  });
  if (owned.some((m) => m.organization.sendingApprovedAt)) return false;
  return owned.length >= UNAPPROVED_WORKSPACE_LIMIT;
}
