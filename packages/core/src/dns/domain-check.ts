import { prisma, type Domain, type DomainStatus } from "@tredmail/db";
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
const HOUR = 60 * MINUTE;
export const DEGRADED_GRACE_MS = 72 * HOUR;

export type DomainChange = "verified" | "recovered" | "degraded" | "failed" | null;

export interface DomainState {
  status: DomainStatus;
  createdAt: Date;
  failingSince: Date | null;
}

export interface DomainTransition {
  status: DomainStatus;
  failingSince: Date | null;
  nextCheckAt: Date | null;
  change: DomainChange;
}

/** When a pending domain is checked next, by how long ago it was added. */
function pendingInterval(age: number): number {
  if (age < HOUR) return 5 * MINUTE;
  if (age < 72 * HOUR) return HOUR;
  return 24 * HOUR;
}

/** The domain's next state after a check. Pure: unit-tested in tests/domains.test.ts. */
export function nextDomainState(state: DomainState, report: Pick<DomainVerificationReport, "isFullyVerified" | "inconclusive">, now = new Date()): DomainTransition {
  const at = (ms: number) => new Date(now.getTime() + ms);
  const same = { status: state.status, failingSince: state.failingSince };

  if (state.status === "SUSPENDED") return { ...same, nextCheckAt: null, change: null };

  if (report.isFullyVerified) {
    const change: DomainChange = state.status === "VERIFIED" ? null : state.status === "PENDING" ? "verified" : "recovered";
    return { status: "VERIFIED", failingSince: null, nextCheckAt: at(24 * HOUR), change };
  }

  if (report.inconclusive) return { ...same, nextCheckAt: at(15 * MINUTE), change: null };

  switch (state.status) {
    case "PENDING":
      return { ...same, nextCheckAt: at(pendingInterval(now.getTime() - state.createdAt.getTime())), change: null };
    case "VERIFIED":
      return { status: "DEGRADED", failingSince: now, nextCheckAt: at(HOUR), change: "degraded" };
    case "DEGRADED": {
      const since = state.failingSince ?? now;
      if (now.getTime() - since.getTime() >= DEGRADED_GRACE_MS) {
        return { status: "FAILED", failingSince: since, nextCheckAt: at(24 * HOUR), change: "failed" };
      }
      return { status: "DEGRADED", failingSince: since, nextCheckAt: at(HOUR), change: null };
    }
    default: // FAILED: keep checking daily so a fixed domain recovers by itself
      return { ...same, nextCheckAt: at(24 * HOUR), change: null };
  }
}

/** First automatic check for a domain that was just added. */
export const firstCheckAt = (now = new Date()) => new Date(now.getTime() + 5 * MINUTE);

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
