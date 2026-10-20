"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_NAV } from "@/components/docs";

export function DocsNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  if (compact) {
    return (
      <nav aria-label="Documentation" className="flex gap-2 overflow-x-auto pb-1">
        {DOCS_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold ${
              pathname === item.href ? "border-navy bg-navy text-offwhite" : "border-line text-navy"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    );
  }
  return (
    <nav aria-label="Documentation" className="space-y-0.5">
      {DOCS_NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`block rounded-md px-3 py-1.5 text-sm ${
              active ? "bg-navy/5 font-bold text-navy shadow-[inset_3px_0_0_var(--color-orange)]" : "text-muted hover:text-navy"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
