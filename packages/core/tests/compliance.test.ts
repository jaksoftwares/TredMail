import { describe, expect, it } from "vitest";
import { checkListUnsubscribeHeaders, findReservedHeaders, withoutSuppressed } from "../src/services/email-validation.js";
import { isSecurityLink, prepareEmailBody, unsubscribeHeaders } from "../src/mail/mime.js";
import { createTrackingSigner } from "../src/security/tracking-signature.js";
import { classifyTrackingHit } from "../src/mail/engagement.js";

const signer = createTrackingSigner("a".repeat(64));
const BASE = "https://track.tredmail.example/v1/track";
const EMAIL_ID = "cmvgkysyx0009ixtdd4hv89d7";

describe("suppressed recipients", () => {
  it("removes only the suppressed addresses, case-insensitively", () => {
    const result = withoutSuppressed(
      { to: ["Ok@example.com", "gone@example.com"], cc: ["GONE@example.com"], bcc: ["keep@example.com"] },
      new Set(["gone@example.com"]),
    );
    expect(result).toEqual({ to: ["Ok@example.com"], cc: [], bcc: ["keep@example.com"], removed: ["gone@example.com"] });
  });
});

describe("List-Unsubscribe headers", () => {
  it("are no longer reserved, so senders can set them", () => {
    expect(findReservedHeaders({ "List-Unsubscribe": "<https://x.example/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" })).toEqual([]);
  });

  it("accept https and mailto entries, and One-Click with an https entry", () => {
    expect(checkListUnsubscribeHeaders({ "List-Unsubscribe": "<https://x.example/u?id=1>, <mailto:u@x.example>" }, false)).toBeNull();
    expect(checkListUnsubscribeHeaders({ "list-unsubscribe": "<https://x.example/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, false)).toBeNull();
    expect(checkListUnsubscribeHeaders(undefined, true)).toBeNull();
  });

  it("refuse malformed values and mixing with TredMail's own", () => {
    expect(checkListUnsubscribeHeaders({ "List-Unsubscribe": "https://x.example/u" }, false)).toMatch(/<https/);
    expect(checkListUnsubscribeHeaders({ "List-Unsubscribe": "<http://x.example/u>" }, false)).toMatch(/<https/);
    expect(checkListUnsubscribeHeaders({ "List-Unsubscribe": "<mailto:u@x.example>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, false)).toMatch(/https:\/\/ entry/);
    expect(checkListUnsubscribeHeaders({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, false)).toMatch(/needs a List-Unsubscribe/);
    expect(checkListUnsubscribeHeaders({ "List-Unsubscribe": "<https://x.example/u>" }, true)).toMatch(/not both/);
  });

  it("TredMail's own are signed per email and one-click", () => {
    const headers = unsubscribeHeaders(EMAIL_ID, BASE, signer);
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = new URL(headers["List-Unsubscribe"].slice(1, -1));
    expect(url.pathname).toBe(`/v1/track/unsubscribe/${EMAIL_ID}`);
    expect(signer.verifyUnsubscribe(EMAIL_ID, url.searchParams.get("sig") ?? undefined)).toBe(true);
    expect(signer.verifyUnsubscribe("someotheremailid000000000", url.searchParams.get("sig") ?? undefined)).toBe(false);
    // An open-pixel signature cannot be reused to unsubscribe
    expect(signer.verifyUnsubscribe(EMAIL_ID, signer.signOpen(EMAIL_ID))).toBe(false);
  });
});

describe("click tracking and security links", () => {
  const track = (html: string) => prepareEmailBody(EMAIL_ID, html, undefined, { trackClicks: true, trackOpens: false, trackingBaseUrl: BASE, signer }).html!;

  it("recognises account-security links", () => {
    expect(isSecurityLink("https://app.example.com/reset-password?token=abc")).toBe(true);
    expect(isSecurityLink("https://app.example.com/auth/verify?code=1")).toBe(true);
    expect(isSecurityLink("https://app.example.com/login/magic?t=1")).toBe(true);
    expect(isSecurityLink("https://app.example.com/invitations/abc")).toBe(false);
    expect(isSecurityLink("https://app.example.com/invite/abc")).toBe(true);
    expect(isSecurityLink("https://shop.example.com/products/authority-book")).toBe(false);
    expect(isSecurityLink("https://shop.example.com/sale")).toBe(false);
  });

  it("never rewrites security links, or links marked data-tredmail-notrack", () => {
    const html = track(
      '<a href="https://app.example.com/reset-password?token=abc">Reset</a> <a data-tredmail-notrack href="https://shop.example.com/a">A</a> <a href="https://shop.example.com/b">B</a>',
    );
    expect(html).toContain('href="https://app.example.com/reset-password?token=abc"');
    expect(html).toContain('<a href="https://shop.example.com/a">A</a>');
    expect(html).not.toContain("data-tredmail-notrack");
    expect(html).toContain(`${BASE}/click/${EMAIL_ID}?url=${encodeURIComponent("https://shop.example.com/b")}`);
  });
});

describe("telling people from software", () => {
  const at = new Date("2026-11-10T12:00:00Z");
  const browser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

  it("counts people, and Gmail's and Yahoo's image proxies", () => {
    expect(classifyTrackingHit({ kind: "open", userAgent: browser, sentAt: null, at }).bot).toBe(false);
    expect(classifyTrackingHit({ kind: "open", userAgent: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)", sentAt: null, at }).bot).toBe(false);
    expect(classifyTrackingHit({ kind: "click", userAgent: browser, sentAt: new Date(at.getTime() - 60_000), at }).bot).toBe(false);
  });

  it("flags scanners, previewers, privacy prefetch and clicks on arrival", () => {
    expect(classifyTrackingHit({ kind: "click", userAgent: "python-requests/2.31", sentAt: null, at })).toEqual({ bot: true, reason: "automated_agent" });
    expect(classifyTrackingHit({ kind: "click", userAgent: "Slackbot-LinkExpanding 1.0", sentAt: null, at }).bot).toBe(true);
    expect(classifyTrackingHit({ kind: "open", userAgent: "Mozilla/5.0", sentAt: null, at })).toEqual({ bot: true, reason: "privacy_prefetch" });
    expect(classifyTrackingHit({ kind: "open", userAgent: "", sentAt: null, at })).toEqual({ bot: true, reason: "no_user_agent" });
    expect(classifyTrackingHit({ kind: "click", userAgent: browser, sentAt: new Date(at.getTime() - 3000), at })).toEqual({ bot: true, reason: "clicked_on_arrival" });
  });
});
