import { prisma } from "@tredmail/db";
import { hardEmailLimit, type Entitlements } from "./plans.js";
import { addDays, usageWindowAt, utcDay, type UsageWindow } from "./periods.js";
import { getEntitlements } from "./subscriptions.js";

/**
 * The usage meter. Every accepted recipient (to, cc and bcc) counts once, on the UTC day the
 * email was accepted. Billing periods start at midnight UTC, so a window's usage is exactly
 * the sum of its days.
 */

const isoDay = (date: Date) => utcDay(date).toISOString().slice(0, 10);

export async function usageBetween(organizationId: string, start: Date, end: Date): Promise<number> {
  const result = await prisma.usageDaily.aggregate({
    where: { organizationId, day: { gte: utcDay(start), lt: utcDay(end) } },
    _sum: { emails: true },
  });
  return result._sum.emails ?? 0;
}

export async function usageOnDay(organizationId: string, day: Date): Promise<number> {
  const row = await prisma.usageDaily.findUnique({ where: { organizationId_day: { organizationId, day: utcDay(day) } } });
  return row?.emails ?? 0;
}

export type UsageFailure = { ok: false; statusCode: 429; error: "daily_limit_exceeded" | "monthly_quota_exceeded"; message: string };

const formatDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Counts `count` recipients against today's and this window's limits. The day's counter is
 * incremented first and checked after, so concurrent sends cannot both slip under the cap;
 * a send that would exceed it is taken back off and refused.
 */
export async function reserveUsage(organizationId: string, count: number, now = new Date()): Promise<{ ok: true; day: Date } | UsageFailure> {
  const { subscription, entitlements } = await getEntitlements(organizationId);
  const day = utcDay(now);
  const [row] = await prisma.$queryRaw<Array<{ emails: number }>>`
    INSERT INTO "usage_daily" ("organizationId", "day", "emails") VALUES (${organizationId}, ${isoDay(now)}::date, ${count})
    ON CONFLICT ("organizationId", "day") DO UPDATE SET "emails" = "usage_daily"."emails" + EXCLUDED."emails"
    RETURNING "emails"`;
  const today = Number(row.emails);

  const refuse = async (failure: UsageFailure) => {
    await releaseUsage(organizationId, count, day);
    return failure;
  };

  if (entitlements.dailyEmails > 0 && today > entitlements.dailyEmails) {
    return refuse({
      ok: false,
      statusCode: 429,
      error: "daily_limit_exceeded",
      message: `This workspace can send ${entitlements.dailyEmails.toLocaleString("en-US")} emails a day on the ${entitlements.planName} plan. The count resets at 00:00 UTC.`,
    });
  }

  const limit = hardEmailLimit(entitlements);
  if (Number.isFinite(limit)) {
    const window = usageWindowAt(subscription.currentPeriodStart, subscription.currentPeriodEnd, now);
    const used = await usageBetween(organizationId, window.start, addDays(day, 1));
    if (used > limit) {
      const extra = entitlements.overagePricePer1000 !== null;
      return refuse({
        ok: false,
        statusCode: 429,
        error: "monthly_quota_exceeded",
        message: extra
          ? `This workspace reached its limit of ${limit.toLocaleString("en-US")} emails this month (including extra emails). It resets on ${formatDate(window.end)}; contact Dovepeak to raise it.`
          : `This workspace used its ${limit.toLocaleString("en-US")} emails for this month on the ${entitlements.planName} plan. Upgrade under Billing, or wait until ${formatDate(window.end)}.`,
      });
    }
  }
  return { ok: true, day };
}

/** Gives back recipients counted on `day` (a scheduled email canceled, a failed insert). */
export async function releaseUsage(organizationId: string, count: number, day: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "usage_daily" SET "emails" = GREATEST("emails" - ${count}, 0)
    WHERE "organizationId" = ${organizationId} AND "day" = ${isoDay(day)}::date`;
}

export interface UsageSummary {
  window: UsageWindow;
  used: number;
  today: number;
  entitlements: Entitlements;
  /** Emails left before sending stops; null = no cap */
  remaining: number | null;
}

export async function usageSummary(organizationId: string, now = new Date()): Promise<UsageSummary> {
  const { subscription, entitlements } = await getEntitlements(organizationId);
  const window = usageWindowAt(subscription.currentPeriodStart, subscription.currentPeriodEnd, now);
  const [used, today] = await Promise.all([
    usageBetween(organizationId, window.start, addDays(utcDay(now), 1)),
    usageOnDay(organizationId, now),
  ]);
  const limit = hardEmailLimit(entitlements);
  return { window, used, today, entitlements, remaining: Number.isFinite(limit) ? Math.max(0, limit - used) : null };
}
