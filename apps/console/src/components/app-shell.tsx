"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { BookOpen, ChevronsUpDown, FileText, Globe, KeyRound, LayoutDashboard, LogOut, Mail, Menu, Settings, ShieldBan, Webhook, X } from "lucide-react";
import { ProductLockup } from "@/components/brand";
import { authClient } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace";

const NAV = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/emails", label: "Emails", icon: Mail },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/domains", label: "Domains", icon: Globe },
  { href: "/api-keys", label: "API keys", icon: KeyRound },
  { href: "/webhooks", label: "Webhooks", icon: Webhook },
  { href: "/suppressions", label: "Suppressions", icon: ShieldBan },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/docs", label: "Docs", icon: BookOpen },
];

/** Closes transient menus when the page they belong to is hidden by route preservation. */
function useTransient(initial = false) {
  const [open, setOpen] = useState(initial);
  useLayoutEffect(() => () => setOpen(false), []);
  return [open, setOpen] as const;
}

function WorkspaceSwitcher() {
  const { me, workspace, switchWorkspace } = useWorkspace();
  const [open, setOpen] = useTransient();
  const router = useRouter();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-md bg-navy-800 px-3 py-2 text-left text-sm text-offwhite hover:bg-navy-700"
      >
        <span className="min-w-0">
          <span className="block truncate font-semibold">{workspace.name}</span>
          <span className="block text-xs text-navy-200">{workspace.role.toLowerCase()}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-navy-200" />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-line bg-surface text-sm text-navy shadow-lg">
          {me.workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => {
                switchWorkspace(w.id);
                setOpen(false);
              }}
              className={`block w-full px-3 py-2 text-left hover:bg-offwhite ${w.id === workspace.id ? "font-bold" : ""}`}
            >
              {w.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => router.push("/onboarding")}
            className="block w-full border-t border-line px-3 py-2 text-left font-semibold hover:bg-offwhite"
          >
            + New workspace
          </button>
        </div>
      )}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col bg-navy px-3 py-4 text-offwhite">
      <Link href="/overview" className="mb-5 px-2" onClick={onNavigate} aria-label="TredMail overview">
        <ProductLockup onDark />
      </Link>
      <WorkspaceSwitcher />
      <nav className="mt-5 flex-1 space-y-0.5" aria-label="Main">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                active ? "bg-navy-700 text-offwhite shadow-[inset_3px_0_0_var(--color-orange)]" : "text-navy-200 hover:bg-navy-800 hover:text-offwhite"
              }`}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </nav>
      <UserMenu />
    </div>
  );
}

function UserMenu() {
  const { me } = useWorkspace();
  const router = useRouter();
  return (
    <div className="mt-4 border-t border-navy-700 px-2 pt-4">
      <p className="truncate text-sm font-semibold">{me.user.name}</p>
      <p className="truncate text-xs text-navy-200">{me.user.email}</p>
      <button
        type="button"
        onClick={async () => {
          await authClient.signOut();
          router.replace("/sign-in");
        }}
        className="mt-3 flex items-center gap-2 text-xs font-semibold text-navy-200 hover:text-offwhite"
      >
        <LogOut className="size-3.5" />
        Sign out
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useTransient();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="hidden bg-navy lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar />
        </div>
      </aside>

      <header className="flex items-center justify-between bg-navy px-4 py-3 lg:hidden">
        <Link href="/overview" aria-label="TredMail overview">
          <ProductLockup onDark compact />
        </Link>
        <button type="button" onClick={() => setMobileOpen(true)} className="text-offwhite" aria-label="Open menu">
          <Menu className="size-5" />
        </button>
      </header>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-navy/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72">
            <button type="button" onClick={() => setMobileOpen(false)} className="absolute right-3 top-3 z-10 text-offwhite" aria-label="Close menu">
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <main className="min-w-0 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
