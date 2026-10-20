import Image from "next/image";
import type { ReactNode } from "react";

/** Product lockup: the Dovepeak brandmark with the TredMail name and its endorsement line. */
export function ProductLockup({ onDark = false, compact = false }: { onDark?: boolean; compact?: boolean }) {
  return (
    <span className={`flex items-center ${compact ? "gap-2" : "gap-2.5"}`}>
      <Image
        src={onDark ? "/brand/brandmark-on-dark.svg" : "/brand/brandmark.svg"}
        alt=""
        width={compact ? 22 : 30}
        height={compact ? 24 : 32}
        priority
      />
      <span className="leading-tight">
        <span className={`block font-extrabold tracking-tight ${compact ? "text-base" : "text-lg"} ${onDark ? "text-offwhite" : "text-navy"}`}>
          TredMail
        </span>
        {!compact && (
          <span className={`block text-[11px] font-semibold ${onDark ? "text-navy-200" : "text-subtle"}`}>by Dovepeak Technologies</span>
        )}
      </span>
    </span>
  );
}

/** "A product of Dovepeak Technologies", with the official primary logo. */
export function DovepeakEndorsement() {
  return (
    <footer className="flex flex-col items-center gap-2 text-xs text-subtle">
      <span>A product of</span>
      <a href="https://dovepeak.com" target="_blank" rel="noreferrer" aria-label="Dovepeak Technologies">
        <Image src="/brand/dovepeak-logo.svg" alt="Dovepeak Technologies" width={130} height={38} />
      </a>
      <span>© Dovepeak Technologies. All rights reserved.</span>
    </footer>
  );
}

/** Centred card layout shared by the sign-in flow, the 404 page and error screens. */
export function BrandFrame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="mb-8">
        <ProductLockup />
      </div>
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6 shadow-sm sm:p-8">{children}</div>
      <div className="mt-10">
        <DovepeakEndorsement />
      </div>
    </main>
  );
}
