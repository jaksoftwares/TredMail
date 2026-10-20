import type { BillingInterval, Plan, Subscription } from "@tredmail/db";

export const FREE_PLAN_ID = "free";
export const INTERNAL_PLAN_ID = "internal";

/** What a workspace may do right now: its plan with any staff overrides applied. */
export interface Entitlements {
  planId: string;
  planName: string;
  currency: string;
  interval: BillingInterval;
  /** Price per interval, minor units */
  price: number;
  /** Included emails per monthly usage window; 0 = unlimited */
  monthlyEmails: number;
  /** 0 = no daily cap */
  dailyEmails: number;
  overagePricePer1000: number | null;
  overageLimit: number | null;
  /** 0 = unlimited */
  maxDomains: number;
  maxMembers: number;
  logRetentionDays: number;
}

export function planPrice(plan: Pick<Plan, "priceMonthly" | "priceYearly">, interval: BillingInterval): number | null {
  return interval === "YEAR" ? plan.priceYearly : plan.priceMonthly;
}

export function resolveEntitlements(subscription: Subscription & { plan: Plan }): Entitlements {
  const { plan } = subscription;
  return {
    planId: plan.id,
    planName: plan.name,
    currency: plan.currency,
    interval: subscription.interval,
    price: subscription.customPrice ?? planPrice(plan, subscription.interval) ?? 0,
    monthlyEmails: subscription.customMonthlyEmails ?? plan.monthlyEmails,
    dailyEmails: subscription.customDailyEmails ?? plan.dailyEmails,
    overagePricePer1000: plan.overagePricePer1000,
    overageLimit: plan.overageLimit,
    maxDomains: subscription.customMaxDomains ?? plan.maxDomains,
    maxMembers: subscription.customMaxMembers ?? plan.maxMembers,
    logRetentionDays: plan.logRetentionDays,
  };
}

/**
 * Most emails a window allows before sending stops: the allowance, plus the overage limit on
 * plans that bill extra emails. Infinity when there is no cap.
 */
export function hardEmailLimit(e: Pick<Entitlements, "monthlyEmails" | "overagePricePer1000" | "overageLimit">): number {
  if (e.monthlyEmails === 0) return Infinity;
  if (e.overagePricePer1000 === null) return e.monthlyEmails;
  return e.overageLimit === null ? Infinity : e.monthlyEmails + e.overageLimit;
}

/** Overage charge for a window: started blocks of 1,000 emails above the allowance. */
export function overageCharge(usage: number, e: Pick<Entitlements, "monthlyEmails" | "overagePricePer1000">) {
  if (e.monthlyEmails === 0 || e.overagePricePer1000 === null || usage <= e.monthlyEmails) {
    return { extraEmails: 0, blocks: 0, amount: 0 };
  }
  const extraEmails = usage - e.monthlyEmails;
  const blocks = Math.ceil(extraEmails / 1000);
  return { extraEmails, blocks, amount: blocks * e.overagePricePer1000 };
}

export type PlanChange = "none" | "upgrade" | "downgrade";

/**
 * Upgrades (a bigger plan, or monthly to yearly on the same plan) start now and are charged
 * now, less a credit for the unused part of the current period. Downgrades wait for the end
 * of the period the customer has already paid for.
 */
export function classifyChange(
  current: { plan: Pick<Plan, "id" | "sortOrder">; interval: BillingInterval },
  target: { plan: Pick<Plan, "id" | "sortOrder">; interval: BillingInterval },
): PlanChange {
  if (current.plan.id === target.plan.id) {
    if (current.interval === target.interval) return "none";
    return target.interval === "YEAR" ? "upgrade" : "downgrade";
  }
  return target.plan.sortOrder > current.plan.sortOrder ? "upgrade" : "downgrade";
}
