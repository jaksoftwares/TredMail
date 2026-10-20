"use client";

import Link from "next/link";
import { BrandFrame } from "@/components/brand";
import { Button } from "@/components/ui";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String(error.digest) : null;
  return (
    <BrandFrame>
      <p className="text-xs font-bold uppercase tracking-wider text-subtle">Something went wrong</p>
      <h1 className="mt-1 text-xl font-bold text-navy">We could not load this page</h1>
      <p className="mt-2 text-sm text-muted">Try again. If the problem continues, contact Dovepeak support and quote the reference below.</p>
      {digest && <p className="mt-3 font-mono text-xs text-subtle">Reference: {digest}</p>}
      <div className="mt-6 flex items-center gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/overview" className="text-sm font-semibold text-navy underline-offset-4 hover:underline">
          Go to the console
        </Link>
      </div>
    </BrandFrame>
  );
}
