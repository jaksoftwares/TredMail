import { describe, expect, it } from "vitest";
import { canGrantScopes, hasScope, normalizeScopes } from "../src/security/scopes.js";

describe("scopes", () => {
  it("grants everything to full_access", () => {
    expect(hasScope(["full_access"], "api_keys:manage")).toBe(true);
  });

  it("denies scopes a key does not hold", () => {
    expect(hasScope(["emails:send"], "api_keys:manage")).toBe(false);
    expect(hasScope(["emails:send"], "domains:manage")).toBe(false);
  });

  it("maps legacy scope names", () => {
    expect(normalizeScopes(["admin", "email:send", "domains:write", "bogus"])).toEqual([
      "full_access",
      "emails:send",
      "domains:manage",
    ]);
  });

  it("prevents a key from minting a more powerful key", () => {
    expect(canGrantScopes(["api_keys:manage", "emails:send"], ["emails:send"])).toBe(true);
    expect(canGrantScopes(["api_keys:manage"], ["full_access"])).toBe(false);
  });
});
