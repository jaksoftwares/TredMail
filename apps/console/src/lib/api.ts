"use client";

export const WORKSPACE_STORAGE_KEY = "tredmail.workspace";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

let currentWorkspaceId: string | null = null;

/** Set by the workspace provider; every API call acts in this workspace. */
export function setApiWorkspace(id: string | null) {
  currentWorkspaceId = id;
}

/**
 * Calls the TredMail API on this origin with the session cookie and the active workspace.
 * Throws ApiError with the API's error code and message on failure.
 */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (currentWorkspaceId) headers["x-tredmail-workspace"] = currentWorkspaceId;

  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    credentials: "same-origin",
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? "request_failed", data?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

/** SWR fetcher: keys are [path, workspaceId] so switching workspace refetches everything. */
export const swrFetcher = ([path]: [string, string | null]) => api(path);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
