"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/workspace";
import { count, day, money } from "@/lib/billing";
import { moneyByCurrency, type AdminOverview, type AdminWorkspaceRow } from "@/lib/admin";
import { Alert, Badge, Button, Card, EmptyState, Input, Select, Spinner, StatusBadge, Table } from "@/components/ui";

function Stat({ label, value, detail, href }: { label: string; value: string | number; detail?: string; href?: string }) {
  const body = (
    <Card className="h-full p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{label}</p>
      <p className="mt-1 text-xl font-bold text-navy">{value}</p>
      {detail && <p className="mt-0.5 text-xs text-muted">{detail}</p>}
    </Card>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

export default function AdminWorkspacesPage() {
  const overview = useApi<AdminOverview>("/v1/admin/overview");
  const [query, setQuery] = useState({ q: "", plan: "", status: "" });
  const [applied, setApplied] = useState(query);
  const params = new URLSearchParams(Object.entries(applied).filter(([, v]) => v) as [string, string][]).toString();
  const list = useApi<{ data: AdminWorkspaceRow[]; next_cursor: string | null }>(`/v1/admin/workspaces${params ? `?${params}` : ""}`);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function runBilling() {
    setRunning(true);
    setRunResult(null);
    try {
      const result = await api<{ cycle: Record<string, unknown>; reconcile: { checked: number } }>("/v1/admin/billing/run", { method: "POST" });
      setRunResult({ ok: true, message: `Billing cycle ran: ${JSON.stringify(result.cycle)}; ${result.reconcile.checked} pending payments checked.` });
      await Promise.all([overview.mutate(), list.mutate()]);
    } catch (err) {
      setRunResult({ ok: false, message: errorMessage(err) });
    } finally {
      setRunning(false);
    }
  }

  const o = overview.data;
  return (
    <>
      {!o ? (
        <Spinner />
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Monthly recurring revenue" value={moneyByCurrency(o.mrr, money)} detail={`${o.paying_workspaces} paying of ${o.workspaces} workspaces`} />
          <Stat label="Collected this month" value={moneyByCurrency(o.collected_this_month, money)} detail={`${o.payments_this_month} payments`} />
          <Stat label="Outstanding" value={moneyByCurrency(o.outstanding, money)} detail={`Overdue ${moneyByCurrency(o.overdue, money)}`} />
          <Stat label="Unmatched payments" value={o.unmatched_payments} detail="Paybill payments with an unknown account number" href="/admin/payments?unmatched=true" />
          <Stat label="Past due" value={o.past_due_workspaces} detail="Renewal or overage unpaid" />
          <Stat label="Sending paused" value={o.paused_workspaces} detail="Circuit breaker" />
          <Stat label="Suspended" value={o.suspended_workspaces} detail="By staff" />
          <Stat label="Plans" value={Object.entries(o.by_plan).map(([p, n]) => `${p} ${n}`).join(" · ") || "—"} />
        </div>
      )}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <form
          className="flex flex-1 flex-col gap-2 sm:flex-row"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setApplied(query);
          }}
        >
          <Input
            aria-label="Search workspaces"
            placeholder="Name, slug, owner email, workspace id or account code"
            value={query.q}
            onChange={(e) => setQuery({ ...query, q: e.target.value })}
          />
          <Select aria-label="Plan" value={query.plan} onChange={(e) => setQuery({ ...query, plan: e.target.value })} className="sm:w-40">
            <option value="">All plans</option>
            {["free", "pro", "scale", "enterprise", "internal"].map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
          <Select aria-label="Status" value={query.status} onChange={(e) => setQuery({ ...query, status: e.target.value })} className="sm:w-40">
            <option value="">Any status</option>
            <option value="past_due">Past due</option>
            <option value="paused">Sending paused</option>
            <option value="suspended">Suspended</option>
          </Select>
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <Button variant="secondary" onClick={runBilling} loading={running}>Run billing now</Button>
      </div>
      {runResult && <div className="mb-4"><Alert tone={runResult.ok ? "success" : "danger"}>{runResult.message}</Alert></div>}

      <Card>
        {!list.data ? (
          <Spinner />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="No workspaces match" />
        ) : (
          <Table head={["Workspace", "Owner", "Plan", "Billing", "Emails (30 days)", "Created"]}>
            {list.data.data.map((w) => (
              <tr key={w.id}>
                <td className="px-4 py-3">
                  <Link href={`/admin/workspaces/${w.id}`} className="font-semibold text-navy underline">{w.name}</Link>
                  <span className="block font-mono text-xs text-subtle">{w.account_code ?? w.slug}</span>
                </td>
                <td className="px-4 py-3 text-muted">{w.owner_email ?? "—"}</td>
                <td className="px-4 py-3">
                  {w.plan_name}
                  {w.plan !== "free" && w.plan !== "internal" && <span className="text-xs text-subtle"> · {w.interval}ly</span>}
                </td>
                <td className="space-x-1 px-4 py-3">
                  <StatusBadge status={w.billing_status} />
                  {w.sending_paused && <Badge tone="danger">paused</Badge>}
                  {w.suspended && <Badge tone="danger">suspended</Badge>}
                </td>
                <td className="px-4 py-3">{count(w.emails_30d)}</td>
                <td className="px-4 py-3 text-muted">{day(w.created_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
