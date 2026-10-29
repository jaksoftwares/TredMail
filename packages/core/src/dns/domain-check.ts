import { prisma, type Domain } from "@tredmail/db";
import { nextDomainState, type DomainChange } from "./domain-schedule.js";
import { env } from "../config/env.js";
import { verifyDomainDns, type DomainVerificationReport } from "./verifier.js";
import { recordAudit } from "../services/audit.js";
import { sendSystemEmail } from "../services/system-mailer.js";
import { domainStatusTemplate } from "../mail/templates.js";
import { dispatchWebhookEvent } from "../webhooks/dispatcher.js";

/**
 * Automatic domain verification and re-checks.
 *
 *  - Pending domains are checked every 5 minutes for their first hour, hourly until 72 hours,
 *    then daily, so a customer who publishes their records is verified without asking.
 *  - Verified domains are re-checked daily. A failed re-check makes the domain DEGRADED: it
 *    still sends, its owners are told, and it is checked hourly. After 72 hours of failing it
 *    becomes FAILED and stops sending (the worker holds its queued mail, see attempts.ts).
 *  - Any later check that passes makes it VERIFIED again.
 *  - A check DNS could not answer (timeouts, server failures) changes nothing and is retried
 *    in 15 minutes. Suspended domains are never checked automatically.
 */

const MINUTE = 60_000;

export { DEGRADED_GRACE_MS, firstCheckAt, nextDomainState } from "./domain-schedule.js";
export type { DomainChange, DomainState, DomainTransition } from "./domain-schedule.js";

const failedRecords = (report: DomainVerificationReport) =>
  report.records.filter((r) => !r.verified && r.recordType !== "RETURN_PATH").map((r) => `${r.recordType}: ${r.error ?? "not found"}`);

export interface CheckResult {
  domain: Domain;
  report: DomainVerificationReport;
  change: DomainChange;
  /** Set when the domain passed but another workspace already verified the same name. */
  ownedElsewhere?: boolean;
}

/**
 * Checks one domain's DNS now and applies the result: status, record flags, schedule, audit
 * entry, owner email and `domain.updated` webhook. Used by the verify endpoint and the worker.
 */
export async function checkDomain(domain: Domain, actor: { actorType: "user" | "api_key" | "system"; actorId: string | null; ipAddress?: string } = { actorType: "system", actorId: null }, now = new Date()): Promise<CheckResult> {
  const report = await verifyDomainDns(domain.name, domain.dkimSelector, domain.dkimPublicKey, `_spf.${env.PRIMARY_DOMAIN}`, env.BOUNCE_DOMAIN);

  // A domain can be verified (and therefore sent from) by only one workspace.
  let ownedElsewhere = false;
  if (report.isFullyVerified && domain.status !== "VERIFIED" && domain.status !== "DEGRADED") {
    ownedElsewhere = !!(await prisma.domain.findFirst({
      where: { name: domain.name, status: { in: ["VERIFIED", "DEGRADED"] }, organizationId: { not: domain.organizationId } },
      select: { id: true },
    }));
  }
  const effective = ownedElsewhere ? { ...report, isFullyVerified: false } : report;
  const transition = nextDomainState(domain, effective, now);
  const errors = failedRecords(report);

  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      status: transition.status,
      failingSince: transition.failingSince,
      nextCheckAt: transition.nextCheckAt,
      lastCheckedAt: now,
      lastCheckError: ownedElsewhere ? "Already verified by another TredMail workspace." : errors.length ? errors.join("\n") : null,
      // Inconclusive checks keep the last known record flags
      ...(report.inconclusive && !report.isFullyVerified
        ? {}
        : {
            dkimVerified: report.dkimVerified,
            spfVerified: report.spfVerified,
            dmarcVerified: report.dmarcVerified,
            returnPathVerified: report.returnPathVerified,
          }),
      ...(transition.change === "verified" || transition.change === "recovered" ? { verifiedAt: now } : {}),
    },
  });

  if (transition.change) await announce(updated, transition.change, errors, actor);
  return { domain: updated, report, change: transition.change, ownedElsewhere };
}

async function domainContacts(organizationId: string): Promise<string[]> {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, role: { in: ["OWNER", "ADMIN"] }, user: { emailVerified: true } },
    select: { user: { select: { email: true } } },
  });
  return [...new Set(members.map((m) => m.user.email.toLowerCase()))];
}

async function announce(domain: Domain, change: Exclude<DomainChange, null>, errors: string[], actor: { actorType: "user" | "api_key" | "system"; actorId: string | null; ipAddress?: string }) {
  await recordAudit({
    organizationId: domain.organizationId,
    ...actor,
    action: `domain.${change}`,
    targetType: "domain",
    targetId: domain.id,
    metadata: { name: domain.name, ...(errors.length ? { problems: errors } : {}) },
  });

  await dispatchWebhookEvent(domain.organizationId, "domain.updated", {
    domain_id: domain.id,
    name: domain.name,
    status: domain.status.toLowerCase(),
    change,
    problems: errors,
  }).catch((err) => console.error(`[domains] webhook for ${domain.name} failed`, err));

  // A user who pressed Verify sees the result on screen; tell owners about everything else.
  if (change === "verified" && actor.actorType === "user") return;
  const url = `${env.CONSOLE_URL.replace(/\/+$/, "")}/domains/${domain.id}`;
  for (const to of await domainContacts(domain.organizationId)) {
    await sendSystemEmail(to, domainStatusTemplate({ domain: domain.name, change, problems: errors, url })).catch((err) =>
      console.error(`[domains] could not email ${to} about ${domain.name}`, err),
    );
  }
}

/** Checks domains whose next check is due (the worker runs this every minute). */
export async function runDueDomainChecks(now = new Date(), limit = 25) {
  const due = await prisma.domain.findMany({
    where: { status: { not: "SUSPENDED" }, nextCheckAt: { lte: now } },
    orderBy: { nextCheckAt: "asc" },
    take: limit,
  });
  const changes: Record<string, number> = {};
  for (const domain of due) {
    try {
      const { change } = await checkDomain(domain, undefined, now);
      if (change) changes[change] = (changes[change] ?? 0) + 1;
    } catch (err) {
      console.error(`[domains] check of ${domain.name} failed`, err);
      // Try again later rather than every minute
      await prisma.domain.update({ where: { id: domain.id }, data: { nextCheckAt: new Date(now.getTime() + 15 * MINUTE) } }).catch(() => undefined);
    }
  }
  return { checked: due.length, changes };
}
