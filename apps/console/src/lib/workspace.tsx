"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import useSWR, { type SWRConfiguration } from "swr";
import { ApiError, WORKSPACE_STORAGE_KEY, api, setApiWorkspace, swrFetcher } from "./api";

export type Role = "OWNER" | "ADMIN" | "DEVELOPER" | "VIEWER";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
  plan_name: string;
  billing_status: "active" | "past_due";
  suspended: boolean;
  sending_paused: boolean;
  role: Role;
}

export interface Me {
  user: { id: string; name: string; email: string; emailVerified: boolean; twoFactorEnabled: boolean | null; image: string | null; isStaff: boolean };
  workspaces: Workspace[];
  pending_invitations: { id: string; workspace: string; role: Role }[];
  sandbox_sender: string;
}

interface WorkspaceContextValue {
  me: Me;
  workspace: Workspace;
  can: {
    manageMembers: boolean;
    manageKeys: boolean;
    manageDomains: boolean;
    manageWebhooks: boolean;
    manageTemplates: boolean;
    send: boolean;
    viewBilling: boolean;
    manageBilling: boolean;
  };
  switchWorkspace: (id: string) => void;
  refreshMe: () => Promise<unknown>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function readStoredWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeWorkspace(id: string) {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
  } catch {
    // storage unavailable; the choice lasts for this page only
  }
}

/** Loads the signed-in user, resolves the active workspace and gates the app shell. */
export function WorkspaceProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const router = useRouter();
  const { data: me, error, mutate } = useSWR<Me>("/v1/me", (path: string) => api<Me>(path), {
    revalidateOnFocus: true,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    // Links in emails name the workspace (?workspace=...) so they open in the right one
    const linked = new URLSearchParams(window.location.search).get("workspace");
    if (linked) storeWorkspace(linked);
    setSelectedId(linked ?? readStoredWorkspace());
  }, []);

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) {
      const next = window.location.pathname + window.location.search;
      router.replace(`/sign-in?next=${encodeURIComponent(next)}`);
    }
  }, [error, router]);

  useEffect(() => {
    if (me && me.workspaces.length === 0) router.replace("/onboarding");
  }, [me, router]);

  const workspace = useMemo(() => {
    if (!me || me.workspaces.length === 0) return null;
    return me.workspaces.find((w) => w.id === selectedId) ?? me.workspaces[0];
  }, [me, selectedId]);

  // Set synchronously so the first child request already carries the workspace header.
  setApiWorkspace(workspace?.id ?? null);

  const switchWorkspace = useCallback((id: string) => {
    storeWorkspace(id);
    setSelectedId(id);
  }, []);

  if (!me || !workspace) return <>{fallback}</>;

  const role = workspace.role;
  const admin = role === "OWNER" || role === "ADMIN";
  const value: WorkspaceContextValue = {
    me,
    workspace,
    can: {
      manageMembers: admin,
      manageKeys: admin,
      manageDomains: admin,
      manageWebhooks: admin,
      manageTemplates: role !== "VIEWER",
      send: role !== "VIEWER",
      viewBilling: admin,
      manageBilling: role === "OWNER",
    },
    switchWorkspace,
    refreshMe: mutate,
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}

/** SWR keyed by workspace, so data reloads when the user switches workspace. */
export function useApi<T>(path: string | null, config?: SWRConfiguration<T>) {
  const { workspace } = useWorkspace();
  return useSWR<T>(path ? [path, workspace.id] : null, swrFetcher as never, config);
}
