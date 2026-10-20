"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";

const TABS = [
  { href: "/admin", label: "Workspaces" },
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/plans", label: "Plans" },
  { href: "/admin/callbacks", label: "Gateway log" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { me } = useWorkspace();
  if (!me.user.isStaff) {
    return (
      <Card>
        <EmptyState title="Staff only" description="The back-office is for TredMail staff at Dovepeak Technologies." />
      </Card>
    );
  }
  return (
    <>
      <PageHeader title="Back-office" description="Workspaces, plans, invoices and payments across TredMail. Every action here is recorded in the workspace's audit log." />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-line" aria-label="Back-office">
        {TABS.map((t) => {
          const active = t.href === "/admin" ? pathname === "/admin" || pathname.startsWith("/admin/workspaces") : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${active ? "border-orange text-navy" : "border-transparent text-subtle hover:text-navy"}`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </>
  );
}
