import { describe, expect, it } from "vitest";
import { ROLE_SCOPES, canAssignRole, canChangeMember, canManageMembers } from "../src/security/roles.js";
import { hasScope } from "../src/security/scopes.js";

describe("workspace roles", () => {
  it("maps roles to scopes", () => {
    expect(hasScope(ROLE_SCOPES.OWNER, "api_keys:manage")).toBe(true);
    expect(hasScope(ROLE_SCOPES.DEVELOPER, "emails:send")).toBe(true);
    expect(hasScope(ROLE_SCOPES.DEVELOPER, "api_keys:manage")).toBe(false);
    expect(hasScope(ROLE_SCOPES.VIEWER, "emails:send")).toBe(false);
  });

  it("lets only owners and admins manage members", () => {
    expect(canManageMembers("OWNER")).toBe(true);
    expect(canManageMembers("ADMIN")).toBe(true);
    expect(canManageMembers("DEVELOPER")).toBe(false);
  });

  it("stops admins from creating or changing owners", () => {
    expect(canAssignRole("ADMIN", "ADMIN")).toBe(true);
    expect(canAssignRole("ADMIN", "OWNER")).toBe(false);
    expect(canChangeMember("ADMIN", "OWNER")).toBe(false);
    expect(canChangeMember("OWNER", "OWNER")).toBe(true);
    expect(canAssignRole("DEVELOPER", "VIEWER")).toBe(false);
  });
});
