"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { can } = useWorkspace();
  const tabs = [
    { href: "/settings", label: "General" },
    { href: "/settings/members", label: "Members" },
    { href: "/settings/security", label: "Security" },
    ...(can.manageMembers ? [{ href: "/settings/audit-log", label: "Audit log" }] : []),
  ];

  return (
    <>
      <PageHeader title="Settings" />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-line" aria-label="Settings">
        {tabs.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${
                active ? "border-orange text-navy" : "border-transparent text-subtle hover:text-navy"
              }`}
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
