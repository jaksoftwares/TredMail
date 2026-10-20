import type { ApiScope } from "./scopes.js";

export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "DEVELOPER", "VIEWER"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * What a signed-in member can do through the console, expressed with the same scopes
 * API keys use, so every route has one permission check for both kinds of caller.
 */
export const ROLE_SCOPES: Record<WorkspaceRole, ApiScope[]> = {
  OWNER: ["full_access"],
  ADMIN: ["full_access"],
  DEVELOPER: ["emails:send", "emails:read", "domains:read", "stats:read", "templates:manage"],
  VIEWER: ["emails:read", "domains:read", "stats:read"],
};

const RANK: Record<WorkspaceRole, number> = { OWNER: 3, ADMIN: 2, DEVELOPER: 1, VIEWER: 0 };

export function canManageMembers(role: WorkspaceRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/**
 * Owners can assign any role. Admins can manage Developers and Viewers, and invite Admins,
 * but cannot create, change or remove Owners.
 */
export function canAssignRole(actor: WorkspaceRole, target: WorkspaceRole): boolean {
  if (actor === "OWNER") return true;
  if (actor === "ADMIN") return RANK[target] <= RANK.ADMIN;
  return false;
}

export function canChangeMember(actor: WorkspaceRole, memberRole: WorkspaceRole): boolean {
  if (actor === "OWNER") return true;
  if (actor === "ADMIN") return memberRole !== "OWNER";
  return false;
}
