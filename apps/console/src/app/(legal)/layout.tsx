import Link from "next/link";
import type { ReactNode } from "react";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b px-4 py-4">
        <Link href="/" className="font-bold text-navy">
          TredMail
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>
      <footer className="border-t px-4 py-6 text-center text-xs text-muted">
        <Link href="/terms" className="underline">
          Terms of Service
        </Link>{" "}
        ·{" "}
        <Link href="/privacy" className="underline">
          Privacy Policy
        </Link>
      </footer>
    </div>
  );
}
