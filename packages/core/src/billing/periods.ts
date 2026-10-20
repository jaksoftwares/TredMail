export type Interval = "MONTH" | "YEAR";

const DAY_MS = 86_400_000;

/** Adds calendar months in UTC, keeping the day of month where it exists (Jan 31 + 1 = Feb 28). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function addInterval(date: Date, interval: Interval, count = 1): Date {
  return addMonths(date, interval === "YEAR" ? 12 * count : count);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Midnight UTC of the day `date` falls on: the key of a usage row. */
export function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Share of [start, end) still ahead of `now`, between 0 and 1. */
export function remainingFraction(start: Date, end: Date, now: Date): number {
  const total = end.getTime() - start.getTime();
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (end.getTime() - now.getTime()) / total));
}

export interface UsageWindow {
  start: Date;
  end: Date;
}

/**
 * Included emails are a monthly allowance, so a yearly period is metered in monthly windows
 * counted from the period start. A monthly period is a single window.
 */
export function usageWindowAt(periodStart: Date, periodEnd: Date, at: Date): UsageWindow {
  let start = periodStart;
  for (let i = 1; i <= 12; i++) {
    const next = addMonths(periodStart, i);
    if (at < next || next >= periodEnd) return { start, end: next < periodEnd ? next : periodEnd };
    start = next;
  }
  return { start, end: periodEnd };
}

/** The monthly windows of a period that ended after `after` and no later than `until`. */
export function closedWindows(periodStart: Date, periodEnd: Date, after: Date, until: Date): UsageWindow[] {
  const windows: UsageWindow[] = [];
  let start = periodStart;
  for (let i = 1; i <= 12 && start < periodEnd; i++) {
    const next = addMonths(periodStart, i);
    const end = next < periodEnd ? next : periodEnd;
    if (end > after && end <= until) windows.push({ start, end });
    start = end;
  }
  return windows;
}

/** Hour of day (0-23) in an IANA time zone. */
export function hourIn(timeZone: string, at: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(at);
  return Number(hour);
}
