import { describe, expect, it } from "vitest";
import { findReservedHeaders, parseFromAddress } from "../src/services/email-validation.js";
import { spfHasInclude } from "../src/dns/verifier.js";

describe("parseFromAddress", () => {
  it("parses bare and display-name forms", () => {
    expect(parseFromAddress("ops@Dovepeak.com")).toEqual({ address: "ops@dovepeak.com", domain: "dovepeak.com" });
    expect(parseFromAddress("Dovepeak <ops@dovepeak.com>")).toEqual({
      address: "ops@dovepeak.com",
      domain: "dovepeak.com",
    });
  });

  it("rejects invalid senders", () => {
    expect(parseFromAddress("not an email")).toBeNull();
    expect(parseFromAddress("Name <a@b@c.com>")).toBeNull();
  });
});

describe("findReservedHeaders", () => {
  it("flags headers TredMail controls, case-insensitively", () => {
    expect(
      findReservedHeaders({ "Return-Path": "x", "DKIM-Signature": "x", "X-TredMail-ID": "x", "X-Custom": "ok" })
    ).toEqual(["Return-Path", "DKIM-Signature", "X-TredMail-ID"]);
  });

  it("flags header names that could inject lines", () => {
    expect(findReservedHeaders({ "X-A\r\nBcc": "x" })).toHaveLength(1);
  });
});

describe("spfHasInclude", () => {
  it("matches the exact include term", () => {
    expect(spfHasInclude("v=spf1 include:_spf.tredmail.dovepeak.com ~all", "_spf.tredmail.dovepeak.com")).toBe(true);
    expect(spfHasInclude("v=spf1 +include:_SPF.tredmail.dovepeak.com. -all", "_spf.tredmail.dovepeak.com")).toBe(true);
  });

  it("does not accept a different provider's include", () => {
    expect(spfHasInclude("v=spf1 include:_spf.google.com ~all", "_spf.tredmail.dovepeak.com")).toBe(false);
    expect(
      spfHasInclude("v=spf1 include:_spf.tredmail.dovepeak.com.evil.com ~all", "_spf.tredmail.dovepeak.com")
    ).toBe(false);
  });
});
