export const API_SCOPES = [
  "full_access",
  "emails:send",
  "emails:read",
  "domains:read",
  "domains:manage",
  "api_keys:manage",
  "webhooks:manage",
  "suppressions:manage",
  "stats:read",
  "templates:manage",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const DEFAULT_KEY_SCOPES: ApiScope[] = ["emails:send"];

// Scope names used by keys created before the scope model existed.
const LEGACY_SCOPES: Record<string, ApiScope> = {
  admin: "full_access",
  "email:send": "emails:send",
  "domains:write": "domains:manage",
};

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

export function normalizeScopes(scopes: readonly string[]): ApiScope[] {
  const normalized = new Set<ApiScope>();
  for (const scope of scopes) {
    const mapped = LEGACY_SCOPES[scope] ?? scope;
    if (isApiScope(mapped)) normalized.add(mapped);
  }
  return [...normalized];
}

export function hasScope(granted: readonly string[], required: ApiScope): boolean {
  const scopes = normalizeScopes(granted);
  return scopes.includes("full_access") || scopes.includes(required);
}

/** A key may only mint keys whose scopes it already holds. */
export function canGrantScopes(granted: readonly string[], requested: readonly ApiScope[]): boolean {
  return requested.every((scope) => hasScope(granted, scope));
}
