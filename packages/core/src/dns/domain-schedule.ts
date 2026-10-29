import type { DomainStatus } from "@tredmail/db";
import type { DomainVerificationReport } from "./verifier.js";

/**
 * When domains are checked and how a check changes their status (see domain-check.ts for the
 * rules in words). Pure and free of I/O imports, so the seed CLI and tests can use it without
 * opening database queues or Redis connections.
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
