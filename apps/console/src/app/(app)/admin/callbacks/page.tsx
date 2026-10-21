"use client";

import { useState } from "react";
import { useApi } from "@/lib/workspace";
import { Card, EmptyState, Spinner, formatDate } from "@/components/ui";

interface Callback {
  id: string;
  gateway: string;
  kind: string;
  payload: unknown;
  ip_address: string | null;
  outcome: string | null;
  created_at: string;
}

/** Every notification a payment gateway sent, newest first, for troubleshooting. */
export default function AdminCallbacksPage() {
  const { data } = useApi<{ data: Callback[] }>("/v1/admin/payment-callbacks", { refreshInterval: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <Spinner />;
  if (data.data.length === 0) return <Card><EmptyState title="No gateway notifications yet" description="M-Pesa results and Paybill or till notifications appear here as they arrive." /></Card>;
  return (
    <Card className="divide-y divide-line">
      {data.data.map((c) => (
        <div key={c.id} className="px-4 py-3 text-sm">
          <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
            <span>
              <span className="font-mono font-semibold">{c.gateway}/{c.kind}</span>
              <span className={`ml-3 ${c.outcome?.startsWith("error") ? "text-danger" : "text-muted"}`}>{c.outcome ?? "processing"}</span>
            </span>
            <span className="text-xs text-subtle">{formatDate(c.created_at)} · {c.ip_address ?? "?"}</span>
          </button>
          {open === c.id && <pre className="mt-2 overflow-x-auto rounded-md bg-offwhite p-3 text-xs">{JSON.stringify(c.payload, null, 2)}</pre>}
        </div>
      ))}
    </Card>
  );
}
