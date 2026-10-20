import type { Metadata } from "next";
import Link from "next/link";
import { DovepeakEndorsement, ProductLockup } from "@/components/brand";
import { DocsNav } from "./docs-nav";

export const metadata: Metadata = {
  title: { default: "Documentation", template: "%s · TredMail docs" },
  description: "Send transactional email with TredMail by Dovepeak Technologies: API, SMTP relay, templates, webhooks and SDKs.",
  robots: { index: true, follow: true },
};

export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Link href="/docs" aria-label="TredMail documentation">
            <ProductLockup compact />
          </Link>
          <div className="flex items-center gap-4 text-sm font-semibold">
            <span className="hidden text-subtle sm:inline">Documentation</span>
            <Link href="/overview" className="rounded-md bg-orange px-3 py-1.5 font-bold text-navy hover:bg-orange-600">
              Console
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-10 px-4 py-8">
        <aside className="hidden w-56 shrink-0 md:block">
          <div className="sticky top-20">
            <DocsNav />
          </div>
        </aside>
        <main className="min-w-0 flex-1 pb-16">
          <div className="mb-6 md:hidden">
            <DocsNav compact />
          </div>
          {children}
        </main>
      </div>
      <div className="border-t border-line py-10">
        <DovepeakEndorsement />
      </div>
    </div>
  );
}
