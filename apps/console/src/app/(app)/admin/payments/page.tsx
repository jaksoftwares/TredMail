"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/workspace";
import { money, type Payment } from "@/lib/billing";
import type { AdminWorkspaceRow } from "@/lib/admin";
import { Alert, Button, Card, Dialog, EmptyState, Field, Input, Select, Spinner, StatusBadge, Table, formatDate } from "@/components/ui";

type Row = Payment & { workspace_name: string | null };

function AssignDialog({ payment, onClose, onDone }: { payment: Row; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const results = useApi<{ data: AdminWorkspaceRow[] }>(search ? `/v1/admin/workspaces?q=${encodeURIComponent(search)}` : null);
  const [orgId, setOrgId] = useState("");
  const invoices = useApi<{ invoices: Array<{ id: string; number: string; status: string; amount_due: number; currency: string }> }>(orgId ? `/v1/admin/workspaces/${orgId}` : null);
  const [invoiceId, setInvoiceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setInvoiceId(""), [orgId]);

  async function assign() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/admin/payments/${payment.id}/assign`, { method: "POST", body: { organization_id: orgId, invoice_id: invoiceId || null } });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`Assign ${money(payment.amount, payment.currency)}`}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Receipt <span className="font-mono">{payment.receipt}</span> from {payment.payer_name ?? "unknown"} ({payment.payer_phone ?? "no phone"}), account number typed: <strong>{payment.account_reference || "none"}</strong>.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); setSearch(q); }}>
          <Input placeholder="Search workspace, owner email or account code" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        {results.data && (
          <Field label="Workspace">
            <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              <option value="">Choose…</option>
              {results.data.data.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.owner_email ?? w.slug}</option>)}
            </Select>
          </Field>
        )}
        {orgId && invoices.data && (
          <Field label="Invoice" hint="Without an invoice, the money becomes account credit.">
            <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">No invoice (account credit)</option>
              {invoices.data.invoices.filter((i) => i.status === "open").map((i) => (
                <option key={i.id} value={i.id}>{i.number} · {money(i.amount_due, i.currency)} due</option>
              ))}
            </Select>
          </Field>
        )}
        <Button onClick={assign} loading={busy} disabled={!orgId}>Assign payment</Button>
      </div>
    </Dialog>
  );
}

export default function AdminPaymentsPage() {
  const [filter, setFilter] = useState({ status: "", unmatched: false, q: "" });
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("unmatched") === "true") setFilter((f) => ({ ...f, unmatched: true }));
  }, []);
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.unmatched) params.set("unmatched", "true");
  if (filter.q) params.set("q", filter.q);
  const { data, mutate } = useApi<{ data: Row[] }>(`/v1/admin/payments?${params}`);
  const [q, setQ] = useState("");
  const [assigning, setAssigning] = useState<Row | null>(null);

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <form className="flex flex-1 gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); setFilter({ ...filter, q }); }}>
          <Input placeholder="Receipt, account number or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <Select aria-label="Status" className="sm:w-40" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="">Any status</option>
          {["pending", "succeeded", "failed", "refunded"].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={filter.unmatched} onChange={(e) => setFilter({ ...filter, unmatched: e.target.checked })} />
          Unmatched only
        </label>
      </div>
      <Card>
        {!data ? <Spinner /> : data.data.length === 0 ? <EmptyState title="No payments match" /> : (
          <Table head={["Date", "Workspace", "Invoice", "Method", "Amount", "Status", "Receipt", ""]}>
            {data.data.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-3 text-muted">{formatDate(p.created_at)}</td>
                <td className="px-4 py-3">
                  {p.organization_id ? <Link href={`/admin/workspaces/${p.organization_id}`} className="font-semibold underline">{p.workspace_name}</Link> : <span className="font-semibold text-danger">Unmatched</span>}
                  {p.account_reference && <span className="block font-mono text-xs text-subtle">ref {p.account_reference}</span>}
                </td>
                <td className="px-4 py-3 font-mono">{p.invoice_number ?? "—"}</td>
                <td className="px-4 py-3">{p.method_label}</td>
                <td className="px-4 py-3 font-semibold">{money(p.amount, p.currency)}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={p.status} />
                  {p.failure_message && <span className="block max-w-xs text-xs text-subtle">{p.failure_message}</span>}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{p.receipt ?? "—"}</td>
                <td className="px-4 py-3 text-right">
                  {!p.organization_id && p.status === "succeeded" && <Button size="sm" onClick={() => setAssigning(p)}>Assign</Button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {assigning && <AssignDialog payment={assigning} onClose={() => setAssigning(null)} onDone={() => { setAssigning(null); void mutate(); }} />}
    </>
  );
}
