import crypto from "node:crypto";
import { prisma, type Plan, type Prisma, type Subscription } from "@tredmail/db";
import { addInterval, utcDay } from "./periods.js";
import { FREE_PLAN_ID, INTERNAL_PLAN_ID, resolveEntitlements, type Entitlements } from "./plans.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type SubscriptionWithPlan = Subscription & { plan: Plan };

/**
 * The workspace's subscription, created on the free plan (internal plan for Dovepeak's own
 * non-commercial workspaces) the first time it is needed.
 */
export async function ensureSubscription(organizationId: string, db: Db = prisma): Promise<SubscriptionWithPlan> {
  const existing = await db.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
  if (existing) return existing;
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { isCommercial: true } });
  const now = utcDay(new Date());
  try {
    return await db.subscription.create({
      data: {
        organizationId,
        planId: org.isCommercial ? FREE_PLAN_ID : INTERNAL_PLAN_ID,
        currentPeriodStart: now,
        currentPeriodEnd: addInterval(now, "MONTH"),
        usageClosedThrough: now,
      },
      include: { plan: true },
    });
  } catch (err) {
    // Created concurrently by another request
    if ((err as { code?: string }).code === "P2002") {
      return db.subscription.findUniqueOrThrow({ where: { organizationId }, include: { plan: true } });
    }
    throw err;
  }
}

export async function getEntitlements(organizationId: string, db: Db = prisma): Promise<{ subscription: SubscriptionWithPlan; entitlements: Entitlements }> {
  const subscription = await ensureSubscription(organizationId, db);
  return { subscription, entitlements: resolveEntitlements(subscription) };
}

// No 0/O, 1/I/L, 2/Z, 5/S, 8/B: easy to read out and type on a phone keypad.
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";

export function generateAccountCode(): string {
  const bytes = crypto.randomBytes(6);
  return `TM${[...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
}

export async function ensureBillingAccount(organizationId: string, db: Db = prisma) {
  const existing = await db.billingAccount.findUnique({ where: { organizationId } });
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.billingAccount.create({ data: { organizationId, accountCode: generateAccountCode() } });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
      const raced = await db.billingAccount.findUnique({ where: { organizationId } });
      if (raced) return raced;
    }
  }
  throw new Error("could not allocate a billing account code");
}

/** Owners' addresses, or the billing email when one is set: where billing mail goes. */
export async function billingRecipients(organizationId: string): Promise<string[]> {
  const [account, owners] = await Promise.all([
    prisma.billingAccount.findUnique({ where: { organizationId }, select: { billingEmail: true } }),
    prisma.organizationMember.findMany({
      where: { organizationId, role: "OWNER", user: { emailVerified: true } },
      select: { user: { select: { email: true } } },
    }),
  ]);
  const list = new Set<string>(owners.map((o) => o.user.email.toLowerCase()));
  if (account?.billingEmail) list.add(account.billingEmail.toLowerCase());
  return [...list];
}
