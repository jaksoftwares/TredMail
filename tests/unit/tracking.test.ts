import { describe, expect, it } from "vitest";
import { createTrackingSigner } from "../../src/security/tracking-signature.js";
import { prepareEmailBody } from "../../src/worker/mime.js";

const signer = createTrackingSigner("b".repeat(64));
const base = "https://track.example.com/v1/track";

describe("tracking signatures", () => {
  it("verifies its own signatures", () => {
    expect(signer.verifyOpen("e1", signer.signOpen("e1"))).toBe(true);
    expect(signer.verifyClick("e1", "https://a.example/", signer.signClick("e1", "https://a.example/"))).toBe(true);
  });

  it("rejects a signature moved to another email or URL", () => {
    const sig = signer.signClick("e1", "https://a.example/");
    expect(signer.verifyClick("e2", "https://a.example/", sig)).toBe(false);
    expect(signer.verifyClick("e1", "https://evil.example/", sig)).toBe(false);
    expect(signer.verifyOpen("e1", undefined)).toBe(false);
  });

  it("rejects signatures from a different master key", () => {
    const other = createTrackingSigner("c".repeat(64));
    expect(signer.verifyOpen("e1", other.signOpen("e1"))).toBe(false);
  });
});

describe("prepareEmailBody", () => {
  it("rewrites links to signed redirects and adds a signed pixel", () => {
    const { html } = prepareEmailBody(
      "e1",
      '<html><body><a href="https://dovepeak.com/a?x=1&amp;y=2">Go</a></body></html>',
      undefined,
      { trackingBaseUrl: base, signer }
    );
    const href = html!.match(/href="([^"]+)"/)![1].replace(/&amp;/g, "&");
    const url = new URL(href);
    expect(url.pathname).toBe("/v1/track/click/e1");
    expect(url.searchParams.get("url")).toBe("https://dovepeak.com/a?x=1&y=2");
    expect(signer.verifyClick("e1", url.searchParams.get("url")!, url.searchParams.get("sig")!)).toBe(true);
    expect(html).toMatch(/<img src="https:\/\/track\.example\.com\/v1\/track\/open\/e1\?sig=[^"]+"[^>]*\/><\/body>/);
  });

  it("leaves content untouched when tracking is off", () => {
    const input = '<a href="https://dovepeak.com">x</a>';
    const { html } = prepareEmailBody("e1", input, "t", {
      trackOpens: false,
      trackClicks: false,
      trackingBaseUrl: base,
      signer,
    });
    expect(html).toBe(input);
  });
});
