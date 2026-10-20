"use client";

import { Open_Sans } from "next/font/google";
import { BrandFrame } from "@/components/brand";
import { Button } from "@/components/ui";
import "./globals.css";

const openSans = Open_Sans({ variable: "--font-open-sans", subsets: ["latin"], weight: ["400", "600", "700", "800"] });

// Replaces the root layout when it fails, so it renders its own document, styles and font.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String(error.digest) : null;
  return (
    <html lang="en" className={`${openSans.variable} h-full antialiased`}>
      <body className="min-h-full">
        <title>TredMail is unavailable</title>
        <BrandFrame>
          <p className="text-xs font-bold uppercase tracking-wider text-subtle">Service interruption</p>
          <h1 className="mt-1 text-xl font-bold text-navy">TredMail is temporarily unavailable</h1>
          <p className="mt-2 text-sm text-muted">Please try again in a moment. If the problem continues, contact Dovepeak support and quote the reference below.</p>
          {digest && <p className="mt-3 font-mono text-xs text-subtle">Reference: {digest}</p>}
          <div className="mt-6">
            <Button onClick={() => retry()}>Try again</Button>
          </div>
        </BrandFrame>
      </body>
    </html>
  );
}
