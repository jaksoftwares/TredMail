import dns from "node:dns/promises";
import { Queue, Worker } from "bullmq";
import { prisma } from "@tredmail/db";
import { env } from "@tredmail/core/config/env";
import { redisConnection } from "@tredmail/core/queue/redis";
import { operationsAlertTemplate } from "@tredmail/core/mail/templates";
import { sendSystemEmail } from "@tredmail/core/services/system-mailer";
import { enqueueEmail } from "@tredmail/core/queue/email.queue";
import { queueWebhookDelivery } from "@tredmail/core/webhooks/dispatcher";
import { runBillingCycle } from "@tredmail/core/billing/cycle";
import { reconcilePendingPayments } from "@tredmail/core/billing/service";
import { checkCircuitBreakers } from "@tredmail/core/services/circuit-breaker";

/**
 * Delivery health checks, every 15 minutes, emailed to OPS_EMAIL. Each alert type is sent at
 * most once every 6 hours. Thresholds follow mailbox-provider guidance: Gmail and Yahoo start
 * filtering above a 0.3% complaint rate, so TredMail warns at 0.1%.
 */

const QUEUE = "tredmail-maintenance";
const EVERY_MS = 15 * 60_000;
const ALERT_COOLDOWN_SECONDS = 6 * 3600;

const BOUNCE_RATE_LIMIT = 0.05;
const COMPLAINT_RATE_LIMIT = 0.001;
const DEFERRALS_PER_HOUR_LIMIT = 50;

// DNS blocklists that matter most to Gmail and Microsoft.
const BLOCKLISTS = ["zen.spamhaus.org", "bl.spamcop.net", "b.barracudacentral.org"];

/** True when mail goes through KumoMTA (not Mailpit), so its delivery events are expected. */
const behindMta = () => !/mailpit|localhost|127\.0\.0\.1/i.test(env.SMTP_HOST);

interface Alert {
  key: string;
  title: string;
  summary: string;
  details: string[];
}

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

async function deliveryAlerts(): Promise<Alert[]> {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 3600_000);
  const hourAgo = new Date(now - 3600_000);
  const countEvents = (type: "DELIVERED" | "BOUNCED" | "COMPLAINED", since: Date) =>
    prisma.emailEvent.count({ where: { type, timestamp: { gte: since } } });

  const [delivered, bounced, complained, recentDeferrals] = await Promise.all([
    countEvents("DELIVERED", dayAgo),
    countEvents("BOUNCED", dayAgo),
    countEvents("COMPLAINED", dayAgo),
    prisma.emailEvent.count({ where: { type: "DEFERRED", timestamp: { gte: hourAgo }, details: { path: ["source"], equals: "mta_log" } } }),
  ]);
  const alerts: Alert[] = [];

  const attempted = delivered + bounced;
  if (attempted >= 20 && bounced / attempted > BOUNCE_RATE_LIMIT) {
    alerts.push({
      key: "bounce-rate",
      title: `Bounce rate is ${pct(bounced / attempted)}`,
      summary: `${bounced} of ${attempted} messages bounced in the last 24 hours (limit ${pct(BOUNCE_RATE_LIMIT)}).`,
      details: [
        "High bounce rates damage the sending IP's reputation. Check the Emails page for the bounced messages and their reasons.",
        "If most bounces are blocks (category 'blocked'), the IP or domain may be listed; if they are unknown users, a sender is mailing an old or bought list.",
      ],
    });
  }
  if (delivered >= 100 && complained / delivered > COMPLAINT_RATE_LIMIT) {
    alerts.push({
      key: "complaint-rate",
      title: `Spam complaint rate is ${pct(complained / delivered)}`,
      summary: `${complained} spam complaints for ${delivered} delivered messages in the last 24 hours (warning level ${pct(COMPLAINT_RATE_LIMIT)}; Gmail filters above 0.30%).`,
      details: ["Complaining recipients are already suppressed. Find which workspace and message type they came from on the Emails page."],
    });
  }
  if (recentDeferrals > DEFERRALS_PER_HOUR_LIMIT) {
    alerts.push({
      key: "deferrals",
      title: `${recentDeferrals} delivery delays in the last hour`,
      summary: "Receiving servers are temporarily refusing mail. This is often throttling by Gmail, Microsoft or Yahoo during warm-up.",
      details: ["KumoMTA keeps retrying for 72 hours. Look at the deferral reasons on the affected emails; a rising number means the sending rate should come down."],
    });
  }

  if (behindMta()) {
    const stuck = await prisma.email.count({
      where: {
        status: "SENT",
        updatedAt: { lt: new Date(now - 2 * 3600_000), gt: new Date(now - 3 * 24 * 3600_000) },
        events: {
          some: { type: "SENT", details: { path: ["route"], equals: "mta" } },
          none: { type: { in: ["DEFERRED", "DELIVERED", "BOUNCED", "FAILED"] } },
        },
      },
    });
    if (stuck > 0) {
      alerts.push({
        key: "mta-events-missing",
        title: `${stuck} emails have no delivery result after 2 hours`,
        summary: "KumoMTA accepted these emails but TredMail has received no delivery, delay or bounce event for them.",
        details: [
          "Check that the kumomta container is running and can reach http://api:3000/internal/mta/events (docker compose logs kumomta).",
          "Check that INTERNAL_API_TOKEN is the same for the api and kumomta services.",
        ],
      });
    }
  }
  return alerts;
}

/** Whether `ip` is listed on `zone`. Spamhaus answers 127.255.255.x to refused queries: not a listing. */
async function isListed(ip: string, zone: string): Promise<boolean> {
  const query = `${ip.split(".").reverse().join(".")}.${zone}`;
  try {
    const answers = await dns.resolve4(query);
    return answers.some((a) => a.startsWith("127.") && !a.startsWith("127.255.255."));
  } catch {
    return false; // NXDOMAIN = not listed; other errors are not evidence of a listing
  }
}

async function blocklistAlerts(): Promise<Alert[]> {
  if (env.NODE_ENV !== "production" || !behindMta()) return [];
  let ips: string[];
  try {
    ips = await dns.resolve4(env.MTA_HOSTNAME);
  } catch {
    return [
      {
        key: "mta-dns",
        title: `${env.MTA_HOSTNAME} does not resolve`,
        summary: `The mail server's hostname has no A record. Receiving servers will reject our mail because its HELO name and PTR cannot be confirmed.`,
        details: ["Add the A record at Namecheap (see docs/PRODUCTION_INFRASTRUCTURE.md)."],
      },
    ];
  }
  const listings: string[] = [];
  for (const ip of ips) {
    for (const zone of BLOCKLISTS) {
      if (await isListed(ip, zone)) listings.push(`${ip} is listed on ${zone}`);
    }
  }
  if (listings.length === 0) return [];
  return [
    {
      key: "blocklist",
      title: "The sending IP is on a blocklist",
      summary: listings.join("; "),
      details: [
        "Find the listing reason on the blocklist's website (Spamhaus: check.spamhaus.org) and request removal once the cause is fixed.",
        "Until it is removed, expect blocks from providers that use this list.",
      ],
    },
  ];
}

async function notify(alert: Alert) {
  const fresh = await redisConnection.set(`tredmail:alert:${alert.key}`, "1", "EX", ALERT_COOLDOWN_SECONDS, "NX");
  if (fresh !== "OK") return;
  console.warn(`[monitor] ALERT ${alert.title}: ${alert.summary}`);
  if (!env.OPS_EMAIL) return;
  try {
    await sendSystemEmail(env.OPS_EMAIL, operationsAlertTemplate(alert));
  } catch (err) {
    console.error("[monitor] could not send alert email", err);
  }
}

export async function runHealthChecks(): Promise<Alert[]> {
  const alerts = [...(await deliveryAlerts()), ...(await blocklistAlerts())];
  for (const alert of alerts) await notify(alert);
  // Per-workspace circuit breaker: pauses customers with high bounce or complaint rates
  const paused = await checkCircuitBreakers().catch((err) => {
    console.error("[monitor] circuit breaker check failed", err);
    return [];
  });
  if (paused.length) console.warn(`[monitor] paused sending for ${paused.length} workspace(s): ${paused.join(", ")}`);
  return alerts;
}

const DAY_MS = 86_400_000;

/** Erases old message bodies and deletes emails (with their events) past the retention limits. */
export async function applyRetention(now = new Date()) {
  const contentCutoff = new Date(now.getTime() - env.EMAIL_CONTENT_RETENTION_DAYS * DAY_MS);
  const recordCutoff = new Date(now.getTime() - env.EMAIL_RECORD_RETENTION_DAYS * DAY_MS);
  const unsent = ["SCHEDULED", "QUEUED", "SENDING"] as const;
  const erased = await prisma.email.updateMany({
    where: {
      createdAt: { lt: contentCutoff },
      status: { notIn: [...unsent] },
      OR: [{ htmlBody: { not: null } }, { textBody: { not: null } }],
    },
    data: { htmlBody: null, textBody: null },
  });
  const attachments = await prisma.emailAttachment.deleteMany({
    where: { email: { createdAt: { lt: contentCutoff }, status: { notIn: [...unsent] } } },
  });
  let deleted = await prisma.email.deleteMany({ where: { createdAt: { lt: recordCutoff } } });
  // Each plan keeps email logs for its own number of days (Free: 7, Pro: 30, ...)
  for (const plan of await prisma.plan.findMany({ select: { id: true, logRetentionDays: true } })) {
    if (plan.logRetentionDays >= env.EMAIL_RECORD_RETENTION_DAYS) continue;
    const cutoff = new Date(now.getTime() - plan.logRetentionDays * DAY_MS);
    const removed = await prisma.email.deleteMany({
      where: { createdAt: { lt: cutoff }, status: { notIn: [...unsent] }, organization: { subscription: { planId: plan.id } } },
    });
    deleted = { count: deleted.count + removed.count };
  }
  await prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DAY_MS) } } });
  await prisma.webhookDelivery.deleteMany({ where: { createdAt: { lt: contentCutoff }, status: { not: "pending" } } });
  await prisma.dmarcReport.deleteMany({ where: { dateBegin: { lt: recordCutoff } } });
  if (erased.count || deleted.count || attachments.count) {
    console.log(`[retention] erased ${erased.count} message bodies and ${attachments.count} attachments, deleted ${deleted.count} old emails`);
  }
  return { erased: erased.count, attachments: attachments.count, deleted: deleted.count };
}

/**
 * Outbox sweeper. The database is the source of truth for what must be sent; this re-queues
 * anything Redis lost (an outage, a flushed instance). Queueing is a no-op for emails and
 * deliveries whose job still exists, because job ids are the row ids.
 */
export async function sweepOutbox(now = new Date()) {
  const stale = new Date(now.getTime() - 2 * 60_000);
  const emails = await prisma.email.findMany({
    where: {
      OR: [
        { status: "QUEUED", updatedAt: { lt: stale } },
        { status: "SCHEDULED", scheduledAt: { lt: stale } },
      ],
    },
    select: { id: true, organizationId: true, domainId: true },
    take: 500,
  });
  for (const email of emails) {
    await enqueueEmail({ emailId: email.id, organizationId: email.organizationId, domainId: email.domainId });
  }
  const deliveries = await prisma.webhookDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
    select: { id: true },
    take: 500,
  });
  for (const delivery of deliveries) await queueWebhookDelivery(delivery.id);
  return { emails: emails.length, webhooks: deliveries.length };
}

/**
 * Schedules health checks, the outbox sweeper, the daily retention run, the billing cycle
 * and payment reconciliation (shared by all worker processes).
 */
export function startMonitor() {
  const queue = new Queue(QUEUE, { connection: redisConnection });
  void Promise.all([
    queue.upsertJobScheduler("delivery-health", { every: EVERY_MS }, { name: "health-check" }),
    queue.upsertJobScheduler("outbox-sweep", { every: 60_000 }, { name: "outbox" }),
    queue.upsertJobScheduler("data-retention", { pattern: "30 2 * * *", tz: "UTC" }, { name: "retention" }),
    queue.upsertJobScheduler("billing-cycle", { every: 10 * 60_000 }, { name: "billing" }),
    queue.upsertJobScheduler("payments-reconcile", { every: 60_000 }, { name: "reconcile" }),
  ]).catch((err) => console.error("[monitor] could not schedule maintenance jobs", err));
  const worker = new Worker(
    QUEUE,
    async (job) => {
      if (job.name === "retention") return applyRetention();
      if (job.name === "outbox") return sweepOutbox();
      if (job.name === "billing") return runBillingCycle();
      if (job.name === "reconcile") return reconcilePendingPayments();
      return (await runHealthChecks()).map((a) => a.key);
    },
    { connection: redisConnection },
  );
  worker.on("failed", (job, err) => console.error(`[monitor] ${job?.name ?? "maintenance"} job failed`, err));
  return {
    async close() {
      await Promise.allSettled([worker.close(), queue.close()]);
    },
  };
}
