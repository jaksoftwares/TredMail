"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Table, formatDate } from "@/components/ui";

interface SuppressionRow {
  id: string;
  email: string;
  reason: string;
  diagnostic: string | null;
  created_at: string;
}

const REASON_LABEL: Record<string, string> = {
  HARD_BOUNCE: "Hard bounce",
  SPAM_COMPLAINT: "Spam complaint",
  UNSUBSCRIBE: "Unsubscribed",
  MANUAL: "Added manually",
};

export default function SuppressionsPage() {
  const { can } = useWorkspace();
  const { data, error, mutate } = useApi<{ data: SuppressionRow[] }>(can.manageKeys ? "/v1/suppressions" : null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!can.manageKeys) {
    return (
      <>
        <PageHeader title="Suppressions" />
        <Alert tone="info">Only workspace Owners and Admins can manage the suppression list.</Alert>
      </>
    );
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFormError(null);
    try {
      await api("/v1/suppressions", { method: "POST", body: { email, reason: "MANUAL" } });
      setOpen(false);
      setEmail("");
      mutate();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function remove(row: SuppressionRow) {
    const warning =
      row.reason === "SPAM_COMPLAINT"
        ? `${row.email} reported your email as spam. Sending to them again can hurt your reputation. Remove anyway?`
        : `Allow sending to ${row.email} again?`;
    if (!confirm(warning)) return;
    try {
      await api(`/v1/suppressions/${row.id}`, { method: "DELETE" });
      mutate();
    } catch (err) {
      alert(errorMessage(err));
    }
  }

  const rows = data?.data.filter((r) => r.email.includes(filter.trim().toLowerCase())) ?? [];

  return (
    <>
      <PageHeader
        title="Suppressions"
        description="TredMail will not send to these addresses. Hard bounces and spam complaints are added automatically to protect your sender reputation."
        actions={<Button onClick={() => setOpen(true)}><Plus className="size-4" />Add address</Button>}
      />
      <Card>
        <div className="border-b border-line p-4">
          <Input placeholder="Filter by address" value={filter} onChange={(e) => setFilter(e.target.value)} className="sm:max-w-sm" />
        </div>
        {error ? (
          <div className="p-4"><Alert tone="danger">{errorMessage(error)}</Alert></div>
        ) : !data ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title={filter ? "No matching addresses" : "No suppressed addresses"} description={filter ? undefined : "Good news: nothing has bounced or complained yet."} />
        ) : (
          <Table head={["Address", "Reason", "Details", "Added", ""]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3 font-semibold">{r.email}</td>
                <td className="px-4 py-3"><Badge tone={r.reason === "MANUAL" ? "neutral" : "warning"}>{REASON_LABEL[r.reason] ?? r.reason}</Badge></td>
                <td className="max-w-72 truncate px-4 py-3 text-muted">{r.diagnostic ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(r.created_at)}</td>
                <td className="px-4 py-3 text-right"><Button variant="secondary" size="sm" onClick={() => remove(r)}>Remove</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} title="Suppress an address">
        <form onSubmit={onAdd} className="space-y-4">
          {formError && <Alert tone="danger">{formError}</Alert>}
          <Field label="Email address" hint="Sends to this address will be refused until you remove it.">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={loading}>Suppress</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
