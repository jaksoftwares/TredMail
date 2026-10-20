"use client";

import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { Spinner } from "@/components/ui";
import { WorkspaceProvider } from "@/lib/workspace";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider fallback={<Spinner label="Loading your workspace" />}>
      <AppShell>{children}</AppShell>
    </WorkspaceProvider>
  );
}
