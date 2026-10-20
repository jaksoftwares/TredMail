"use client";

import { count } from "@/lib/billing";

/** A labelled bar for usage against a limit; with no limit it shows the count only. */
export function UsageMeter({ label, used, limit, note }: { label: string; used: number; limit: number; note?: string }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const over = limit > 0 && used >= limit;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold text-navy">{label}</span>
        <span className="text-muted">
          <span className="font-bold text-navy">{count(used)}</span> {limit > 0 ? `of ${count(limit)}` : "· no limit"}
        </span>
      </div>
      {limit > 0 && (
        <div
          className="h-2 overflow-hidden rounded-full bg-navy/10"
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
        >
          <div className={`h-full rounded-full ${over ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-orange"}`} style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%` }} />
        </div>
      )}
      {note && <p className="mt-1 text-xs text-subtle">{note}</p>}
    </div>
  );
}
