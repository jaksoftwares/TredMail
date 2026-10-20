import { prisma } from "@tredmail/db";
import { getEntitlements } from "@tredmail/core/billing/subscriptions";

type LimitResult = { ok: true } | { ok: false; statusCode: 403; error: "plan_limit_reached"; message: string };

/**
 * Whether the workspace's plan has room for one more domain or member. Pending invitations
 * count as members (except one to `email`, which the new invitation replaces or redeems).
 */
export async function checkPlanLimit(organizationId: string, resource: "domains" | "members", email?: string): Promise<LimitResult> {
  const { entitlements } = await getEntitlements(organizationId);
  const max = resource === "domains" ? entitlements.maxDomains : entitlements.maxMembers;
  if (max === 0) return { ok: true };

  let used: number;
  if (resource === "domains") {
    used = await prisma.domain.count({ where: { organizationId } });
  } else {
    const [members, invitations] = await Promise.all([
      prisma.organizationMember.count({ where: { organizationId } }),
      prisma.invitation.count({
        where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, ...(email ? { email: { not: email } } : {}) },
      }),
    ]);
    used = members + invitations;
  }
  if (used < max) return { ok: true };

  const noun = resource === "domains" ? (max === 1 ? "sending domain" : "sending domains") : max === 1 ? "member" : "members (including pending invitations)";
  return {
    ok: false,
    statusCode: 403,
    error: "plan_limit_reached",
    message: `The ${entitlements.planName} plan allows ${max} ${noun}. Upgrade under Billing to add more.`,
  };
}
