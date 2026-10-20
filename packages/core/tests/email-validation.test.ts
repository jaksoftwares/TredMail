import { describe, expect, it } from "vitest";
import { findReservedHeaders, parseFromAddress } from "../src/services/email-validation.js";
import { spfHasInclude } from "../src/dns/verifier.js";

describe("parseFromAddress", () => {
  it("parses bare and display-name forms", () => {
    expect(parseFromAddress("ops@Dovepeakdigital.com")).toEqual({ address: "ops@dovepeakdigital.com", domain: "dovepeakdigital.com" });
    expect(parseFromAddress("Dovepeak <ops@dovepeakdigital.com>")).toEqual({
      address: "ops@dovepeakdigital.com",
      domain: "dovepeakdigital.com",
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
    expect(spfHasInclude("v=spf1 include:_spf.tredmail.dovepeakdigital.com ~all", "_spf.tredmail.dovepeakdigital.com")).toBe(true);
    expect(spfHasInclude("v=spf1 +include:_SPF.tredmail.dovepeakdigital.com. -all", "_spf.tredmail.dovepeakdigital.com")).toBe(true);
  });

  it("does not accept a different provider's include", () => {
    expect(spfHasInclude("v=spf1 include:_spf.google.com ~all", "_spf.tredmail.dovepeakdigital.com")).toBe(false);
    expect(
      spfHasInclude("v=spf1 include:_spf.tredmail.dovepeakdigital.com.evil.com ~all", "_spf.tredmail.dovepeakdigital.com")
    ).toBe(false);
  });
});
