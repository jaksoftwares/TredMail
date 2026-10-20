import { prisma } from "@tredmail/db";
import { env } from "../config/env.js";
import { customerGateways } from "./gateways/registry.js";
import { notifyInvoiceIssued, notifyOverdue, notifyPlanChange, notifyUsage } from "./notify.js";
import { addDays, addInterval, closedWindows, hourIn, usageWindowAt, utcDay } from "./periods.js";
import { FREE_PLAN_ID, hardEmailLimit, planPrice, resolveEntitlements } from "./plans.js";
import { billOverage, issueRenewalInvoice, refreshPastDue, startPayment } from "./service.js";
import type { SubscriptionWithPlan } from "./subscriptions.js";
import { usageBetween } from "./usage.js";

/**
 * The billing clock, run by the worker every few minutes (and by tests with a chosen `now`).
 * Every step is idempotent: running it twice, or after a long pause, gives the same result.
 */
export async function runBillingCycle(now = new Date()) {
  return {
    windowsClosed: await closeUsageWindows(now),
    renewalsIssued: await issueRenewals(now),
    periodsRolled: await rollOverPeriods(now),
    paymentRequests: await autoCollect(now),
    dunning: await runDunning(now),
    checkoutsExpired: await expireCheckouts(now),
    usageWarnings: await usageWarnings(now),
  };
}

type After = Array<() => Promise<unknown>>;
async function flush(after: After) {
  for (const task of after) await task().catch((err) => console.error("[billing] follow-up failed", err));
}

/** Bills overage for monthly usage windows that have ended, and resets usage warnings. */
export async function closeUsageWindows(now = new Date()) {
  const subscriptions = await prisma.subscription.findMany({
    where: { OR: [{ currentPeriodEnd: { lte: now } }, { interval: "YEAR" }] },
    include: { plan: true },
  });
  let closed = 0;
  for (const subscription of subscriptions) {
    const after = subscription.usageClosedThrough ?? subscription.currentPeriodStart;
    const windows = closedWindows(subscription.currentPeriodStart, subscription.currentPeriodEnd, after, now);
    for (const window of windows) {
      const tasks: After = [];
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.subscription.updateMany({
          where: { id: subscription.id, OR: [{ usageClosedThrough: null }, { usageClosedThrough: { lt: window.end } }] },
          data: { usageClosedThrough: window.end, usageAlertLevel: 0 },
        });
        if (claimed.count === 1) await billOverage(tx, subscription, window, tasks, now);
      });
      await flush(tasks);
      closed++;
    }
  }
  return closed;
}

async function paymentPromptPhone(organizationId: string, currency: string): Promise<string | null> {
  const account = await prisma.billingAccount.findUnique({ where: { organizationId } });
  if (!account?.autoCollect || !account.phone) return null;
  return customerGateways(currency).some((g) => g.payerFields.some((f) => f.name === "phone")) ? account.phone : null;
}

/** Issues renewal invoices BILLING_RENEWAL_NOTICE_DAYS before paid periods end. */
export async function issueRenewals(now = new Date()) {
  const subscriptions = await prisma.subscription.findMany({
    where: {
      currentPeriodEnd: { lte: addDays(now, env.BILLING_RENEWAL_NOTICE_DAYS) },
      cancelAtPeriodEnd: false,
      OR: [{ plan: { priceMonthly: { gt: 0 } } }, { pendingPlanId: { not: null } }, { customPrice: { gt: 0 } }],
    },
    include: { plan: true },
  });
  let issued = 0;
  for (const subscription of subscriptions) {
    const invoice = await issueRenewalInvoice(subscription, now);
    if (!invoice) continue;
    issued++;
    if (invoice.status === "OPEN") await notifyInvoiceIssued(invoice.id, await paymentPromptPhone(invoice.organizationId, invoice.currency));
  }
  return issued;
}

/** Starts the next period for subscriptions whose period has ended, applying scheduled changes. */
export async function rollOverPeriods(now = new Date()) {
  const due = await prisma.subscription.findMany({ where: { currentPeriodEnd: { lte: now } }, include: { plan: true } });
  let rolled = 0;
  for (const subscription of due) {
    const nextPlanId = subscription.cancelAtPeriodEnd ? FREE_PLAN_ID : (subscription.pendingPlanId ?? subscription.planId);
    const interval = subscription.cancelAtPeriodEnd ? "MONTH" : (subscription.pendingInterval ?? subscription.interval);
    const plan = nextPlanId === subscription.planId ? subscription.plan : await prisma.plan.findUnique({ where: { id: nextPlanId } });
    if (!plan) continue;
    const sameDeal = nextPlanId === subscription.planId && interval === subscription.interval;
    const price = sameDeal && subscription.customPrice !== null ? subscription.customPrice : (planPrice(plan, interval) ?? 0);

    // A paid period needs its renewal invoice (normally issued days earlier)
    if (price > 0) await issueRenewalInvoice(subscription, now);

    let start = subscription.currentPeriodEnd;
    let end = addInterval(start, interval);
    if (price === 0) {
      while (end <= now) {
        start = end;
        end = addInterval(start, interval);
      }
    }
    const renewal = price > 0
      ? await prisma.invoice.findFirst({ where: { organizationId: subscription.organizationId, purpose: "renewal", periodStart: subscription.currentPeriodEnd, status: { not: "VOID" } } })
      : null;

    const moved = await prisma.$transaction(async (tx) => {
      const claimed = await tx.subscription.updateMany({
        where: { id: subscription.id, currentPeriodEnd: subscription.currentPeriodEnd },
        data: {
          planId: plan.id,
          interval,
          currentPeriodStart: start,
          currentPeriodEnd: end,
          periodAmountPaid: renewal?.status === "PAID" ? renewal.subtotal : 0,
          cancelAtPeriodEnd: false,
          pendingPlanId: null,
          pendingInterval: null,
          usageClosedThrough: start,
          usageAlertLevel: 0,
          ...(sameDeal ? {} : { customPrice: null, customMonthlyEmails: null, customDailyEmails: null, customMaxDomains: null, customMaxMembers: null }),
        },
      });
      if (claimed.count === 0) return false;
      await refreshPastDue(tx, subscription.organizationId, now);
      return true;
    });
    if (!moved) continue;
    rolled++;
    if (plan.id !== subscription.planId) {
      await notifyPlanChange(subscription.organizationId, `You are now on the ${plan.name} plan`, `As scheduled, the workspace moved from the ${subscription.plan.name} plan to the ${plan.name} plan on ${start.toISOString().slice(0, 10)}.`);
    }
  }
  return rolled;
}

/** Sends M-Pesa prompts for new renewal and overage invoices, in daytime only. */
export async function autoCollect(now = new Date()) {
  const hour = hourIn(env.BILLING_TIMEZONE, now);
  if (hour < 8 || hour >= 20) return 0;
  const invoices = await prisma.invoice.findMany({
    where: { status: "OPEN", purpose: { in: ["renewal", "overage"] }, autoCollectedAt: null },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  let sent = 0;
  for (const invoice of invoices) {
    const claimed = await prisma.invoice.updateMany({ where: { id: invoice.id, autoCollectedAt: null }, data: { autoCollectedAt: now } });
    if (claimed.count === 0) continue;
    const phone = await paymentPromptPhone(invoice.organizationId, invoice.currency);
    if (!phone) continue;
    const gateway = customerGateways(invoice.currency).find((g) => g.payerFields.some((f) => f.name === "phone"));
    if (!gateway) continue;
    const result = await startPayment(invoice.organizationId, invoice.id, gateway.id, { phone }, { userId: null }, now);
    if (result.ok && result.payment.status !== "FAILED") sent++;
  }
  return sent;
}

/** Reminds about overdue invoices and moves workspaces to Free once the grace period is over. */
export async function runDunning(now = new Date()) {
  const pastDue = await prisma.subscription.findMany({ where: { status: "PAST_DUE" }, include: { plan: true } });
  let downgraded = 0;
  let reminded = 0;
  for (const subscription of pastDue) {
    const overdue = await prisma.invoice.findFirst({
      where: { organizationId: subscription.organizationId, status: "OPEN", purpose: { in: ["renewal", "overage"] }, dueAt: { lte: now } },
      orderBy: { dueAt: "asc" },
    });
    if (!overdue) continue;
    const isPaid = (subscription.customPrice ?? planPrice(subscription.plan, subscription.interval) ?? 0) > 0;
    const downgradeAt = addDays(subscription.pastDueSince ?? now, env.BILLING_GRACE_DAYS);

    if (isPaid && now >= downgradeAt) {
      await downgradeForNonPayment(subscription, overdue.number, now);
      downgraded++;
      continue;
    }
    if (!overdue.lastReminderAt || overdue.lastReminderAt < addDays(now, -2)) {
      await prisma.invoice.update({ where: { id: overdue.id }, data: { lastReminderAt: now } });
      await notifyOverdue(overdue.id, subscription.plan.name, isPaid ? downgradeAt : addDays(now, env.BILLING_GRACE_DAYS));
      reminded++;
    }
  }
  return { downgraded, reminded };
}

async function downgradeForNonPayment(subscription: SubscriptionWithPlan, invoiceNumber: string, now: Date) {
  const start = utcDay(now);
  await prisma.$transaction(async (tx) => {
    // Renewals for the paid plan are no longer owed; money already paid on them becomes credit.
    const renewals = await tx.invoice.findMany({ where: { organizationId: subscription.organizationId, purpose: "renewal", status: "OPEN" } });
    for (const invoice of renewals) {
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: "VOID", voidedAt: now } });
      if (invoice.amountPaid > 0) {
        await tx.billingAccount.updateMany({ where: { organizationId: subscription.organizationId }, data: { creditBalance: { increment: invoice.amountPaid } } });
      }
    }
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: FREE_PLAN_ID,
        interval: "MONTH",
        currentPeriodStart: start,
        currentPeriodEnd: addInterval(start, "MONTH"),
        periodAmountPaid: 0,
        cancelAtPeriodEnd: false,
        pendingPlanId: null,
        pendingInterval: null,
        customPrice: null,
        customMonthlyEmails: null,
        customDailyEmails: null,
        customMaxDomains: null,
        customMaxMembers: null,
        usageClosedThrough: start,
        usageAlertLevel: 0,
      },
    });
    await refreshPastDue(tx, subscription.organizationId, now);
  });
  await notifyPlanChange(
    subscription.organizationId,
    "Moved to the Free plan",
    `Invoice ${invoiceNumber} was not paid within ${env.BILLING_GRACE_DAYS} days, so the workspace moved from the ${subscription.plan.name} plan to the Free plan and its limits. Choose a plan under Billing to upgrade again.`,
  );
}

/** Voids upgrade checkouts nobody paid. */
export async function expireCheckouts(now = new Date()) {
  const result = await prisma.invoice.updateMany({
    where: { purpose: "plan_change", status: "OPEN", amountPaid: 0, dueAt: { lt: now } },
    data: { status: "VOID", voidedAt: now },
  });
  return result.count;
}

/** Emails owners at 80% and 100% of the monthly allowance, once per window. */
export async function usageWarnings(now = new Date()) {
  const subscriptions = await prisma.subscription.findMany({
    where: { usageAlertLevel: { lt: 100 }, OR: [{ plan: { monthlyEmails: { gt: 0 } } }, { customMonthlyEmails: { gt: 0 } }] },
    include: { plan: true },
  });
  let sent = 0;
  for (const subscription of subscriptions) {
    const entitlements = resolveEntitlements(subscription);
    if (entitlements.monthlyEmails === 0) continue;
    const window = usageWindowAt(subscription.currentPeriodStart, subscription.currentPeriodEnd, now);
    const used = await usageBetween(subscription.organizationId, window.start, addDays(utcDay(now), 1));
    const ratio = used / entitlements.monthlyEmails;
    const level = ratio >= 1 ? 100 : ratio >= 0.8 ? 80 : 0;
    if (level <= subscription.usageAlertLevel) continue;
    const claimed = await prisma.subscription.updateMany({
      where: { id: subscription.id, usageAlertLevel: { lt: level } },
      data: { usageAlertLevel: level },
    });
    if (claimed.count === 0) continue;
    await notifyUsage(subscription.organizationId, {
      percent: level,
      used,
      limit: entitlements.monthlyEmails,
      planName: entitlements.planName,
      resetAt: window.end,
      billsExtra: entitlements.overagePricePer1000 !== null && hardEmailLimit(entitlements) > entitlements.monthlyEmails,
    });
    sent++;
  }
  return sent;
}
