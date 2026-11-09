import { describe, expect, it } from "vitest";
import { needsSendingApproval } from "../src/services/sending-approval.js";
import { breakerDecision } from "../src/services/circuit-breaker.js";

describe("sending approval (H4)", () => {
  it("applies to commercial workspaces that are not approved yet", () => {
    expect(needsSendingApproval({ isCommercial: true, sendingApprovedAt: null })).toBe(true);
    expect(needsSendingApproval({ isCommercial: true, sendingApprovedAt: new Date() })).toBe(false);
  });

  it("never applies to Dovepeak's own internal workspaces", () => {
    expect(needsSendingApproval({ isCommercial: false, sendingApprovedAt: null })).toBe(false);
  });
});

describe("circuit breaker windows", () => {
  it("names the window it measured, so a one-hour pause is explained correctly", () => {
    const stats = { delivered: 10, hardBounced: 60, complained: 0 };
    expect(breakerDecision(stats, 1)).toMatch(/in the last hour/);
    expect(breakerDecision(stats)).toMatch(/in the last 24 hours/);
  });

  it("applies the same limits in the one-hour window", () => {
    expect(breakerDecision({ delivered: 900, hardBounced: 10, complained: 0 }, 1)).toBeNull();
    expect(breakerDecision({ delivered: 0, hardBounced: 60, complained: 0 }, 1)).not.toBeNull();
  });
});
