"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/workspace";
import { count, day, limitLabel, money, PURPOSE_LABEL, type Invoice } from "@/lib/billing";
import { toMajor, toMinor, type AdminPlan, type AdminWorkspace } from "@/lib/admin";
import { UsageMeter } from "@/components/usage-meter";
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Spinner, StatusBadge, Table, Textarea, formatDate } from "@/components/ui";

type Action = "plan" | "suspend" | "credit" | "payment" | "invoice" | null;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-semibold">{children}</dd>
    </div>
  );
}

function useSubmit(onDone: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onDone();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

function PlanForm({ data, plans, onDone }: { data: AdminWorkspace; plans: AdminPlan[]; onDone: () => Promise<unknown> }) {
  const s = data.subscription;
  const [form, setForm] = useState({
    plan: s.plan.id,
    interval: s.interval,
    custom_price: toMajor(s.custom.price),
    custom_monthly_emails: s.custom.monthly_emails?.toString() ?? "",
    custom_daily_emails: s.custom.daily_emails?.toString() ?? "",
    custom_max_domains: s.custom.max_domains?.toString() ?? "",
    custom_max_members: s.custom.max_members?.toString() ?? "",
    restart_period: true,
  });
  const { busy, error, run } = useSubmit(onDone);
  const int = (v: string) => (v.trim() === "" ? null : Number(v.replace(/[,\s]/g, "")));
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void run(() =>
          api(`/v1/admin/workspaces/${data.workspace.id}/plan`, {
            method: "POST",
            body: {
              plan: form.plan,
              interval: form.interval,
              custom_price: toMinor(form.custom_price),
              custom_monthly_emails: int(form.custom_monthly_emails),
              custom_daily_emails: int(form.custom_daily_emails),
              custom_max_domains: int(form.custom_max_domains),
              custom_max_members: int(form.custom_max_members),
              restart_period: form.restart_period,
            },
          }),
        );
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-sm text-muted">Moves the workspace without charging. Renewals bill the custom price if set, otherwise the plan's price. Leave custom fields empty to use the plan's values.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Plan">
          <Select value={form.plan} onChange={set("plan")}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_public ? "" : " (hidden)"}</option>)}
          </Select>
        </Field>
        <Field label="Billing interval">
          <Select value={form.interval} onChange={set("interval")}>
            <option value="month">Monthly</option>
            <option value="year">Yearly</option>
          </Select>
        </Field>
        <Field label="Custom price per interval (KES)"><Input inputMode="decimal" value={form.custom_price} onChange={set("custom_price")} /></Field>
        <Field label="Emails per month" hint="0 = unlimited"><Input inputMode="numeric" value={form.custom_monthly_emails} onChange={set("custom_monthly_emails")} /></Field>
        <Field label="Emails per day" hint="0 = no daily cap"><Input inputMode="numeric" value={form.custom_daily_emails} onChange={set("custom_daily_emails")} /></Field>
        <Field label="Max domains" hint="0 = unlimited"><Input inputMode="numeric" value={form.custom_max_domains} onChange={set("custom_max_domains")} /></Field>
        <Field label="Max members" hint="0 = unlimited"><Input inputMode="numeric" value={form.custom_max_members} onChange={set("custom_max_members")} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.restart_period} onChange={(e) => setForm({ ...form, restart_period: e.target.checked })} />
        Start a new period today
      </label>
      <Button type="submit" loading={busy}>Save plan</Button>
    </form>
  );
}

function SimpleForm({
  fields,
  submitLabel,
  onSubmit,
  onDone,
  intro,
}: {
  fields: Array<{ name: string; label: string; hint?: string; type?: "text" | "textarea" | "select"; options?: Array<[string, string]>; required?: boolean }>;
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  onDone: () => Promise<unknown>;
  intro?: ReactNode;
}) {
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.name, f.options?.[0]?.[0] ?? ""])));
  const { busy, error, run } = useSubmit(onDone);
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void run(() => onSubmit(values));
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {intro && <div className="text-sm text-muted">{intro}</div>}
      {fields.map((f) => (
        <Field key={f.name} label={f.label} hint={f.hint}>
          {f.type === "textarea" ? (
            <Textarea rows={3} required={f.required} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
          ) : f.type === "select" ? (
            <Select value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
              {f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          ) : (
            <Input required={f.required} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
          )}
        </Field>
      ))}
      <Button type="submit" loading={busy}>{submitLabel}</Button>
    </form>
  );
}

export default function AdminWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const { data, mutate, error } = useApi<AdminWorkspace>(`/v1/admin/workspaces/${id}`);
  const plans = useApi<{ data: AdminPlan[] }>("/v1/admin/plans");
  const [action, setAction] = useState<Action>(null);
  const [viewing, setViewing] = useState<Invoice | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  if (error) return <Alert tone="danger">{errorMessage(error)}</Alert>;
  if (!data) return <Spinner />;
  const w = data.workspace;
  const s = data.subscription;
  const e = data.entitlements;
  const done = async () => {
    setAction(null);
    await mutate();
  };

  async function quick(label: string, fn: () => Promise<unknown>) {
    setNotice(null);
    try {
      await fn();
      setNotice({ ok: true, message: label });
      await mutate();
    } catch (err) {
      setNotice({ ok: false, message: errorMessage(err) });
    }
  }

  async function openInvoice(invoiceId: string) {
    try {
      setViewing(await api<Invoice>(`/v1/admin/invoices/${invoiceId}`));
    } catch (err) {
      setNotice({ ok: false, message: errorMessage(err) });
    }
  }

  const openInvoices = data.invoices.filter((i) => i.status === "open");

  return (
    <>
      <Link href="/admin" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-navy hover:underline">
        <ArrowLeft className="size-4" /> Workspaces
      </Link>
      <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-bold text-navy">{w.name}</h2>
          <p className="font-mono text-xs text-subtle">{w.id} · {data.account.account_code}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone="accent">{s.plan.name}</Badge>
            <StatusBadge status={s.status} />
            {!w.is_commercial && <Badge tone="info">Dovepeak internal</Badge>}
            {w.suspended_at && <Badge tone="danger">suspended</Badge>}
            {w.sending_paused_at && <Badge tone="danger">sending paused</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setAction("plan")}>Set plan</Button>
          <Button variant="secondary" size="sm" onClick={() => setAction("payment")}>Record payment</Button>
          <Button variant="secondary" size="sm" onClick={() => setAction("invoice")}>Create invoice</Button>
          <Button variant="secondary" size="sm" onClick={() => setAction("credit")}>Adjust credit</Button>
          {w.sending_paused_at && <Button size="sm" onClick={() => quick("Sending resumed.", () => api(`/v1/admin/workspaces/${w.id}/resume-sending`, { method: "POST" }))}>Resume sending</Button>}
          {w.suspended_at ? (
            <Button size="sm" onClick={() => quick("Suspension lifted.", () => api(`/v1/admin/workspaces/${w.id}/unsuspend`, { method: "POST" }))}>Lift suspension</Button>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setAction("suspend")}>Suspend</Button>
          )}
        </div>
      </div>

      <div className="mb-6 space-y-2">
        {notice && <Alert tone={notice.ok ? "success" : "danger"}>{notice.message}</Alert>}
        {w.suspended_at && <Alert tone="danger">Suspended {formatDate(w.suspended_at)}: {w.suspended_reason}</Alert>}
        {w.sending_paused_at && <Alert tone="danger">Sending paused {formatDate(w.sending_paused_at)}: {w.sending_pause_reason}</Alert>}
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="p-5">
          <h3 className="mb-2 font-bold">Subscription</h3>
          <dl className="divide-y divide-line">
            <Row label="Plan">{s.plan.name} · {s.interval}ly</Row>
            <Row label="Price">{e.price > 0 ? `${money(e.price, e.currency)} / ${e.interval}` : "Free"}{s.custom.price !== null ? " (custom)" : ""}</Row>
            <Row label="Period">{day(s.current_period_start)} to {day(s.current_period_end)}</Row>
            {s.pending_change && <Row label="Scheduled">{s.pending_change.plan_name} on {day(s.pending_change.effective_at)}</Row>}
            {s.past_due_since && <Row label="Past due since">{day(s.past_due_since)}</Row>}
            <Row label="Limits">{limitLabel(e.max_domains, "domains")} · {limitLabel(e.max_members, "members")}</Row>
            <Row label="Credit">{money(data.account.credit_balance, e.currency)}</Row>
          </dl>
        </Card>
        <Card className="space-y-4 p-5">
          <h3 className="font-bold">Usage</h3>
          <UsageMeter label="This month" used={data.usage.emails_sent} limit={data.usage.monthly_limit} note={`Resets ${day(data.usage.period_end)}`} />
          <UsageMeter label="Today" used={data.usage.emails_today} limit={data.usage.daily_limit} />
        </Card>
        <Card className="p-5 text-sm">
          <h3 className="mb-2 font-bold">Account</h3>
          <dl className="divide-y divide-line">
            <Row label="Billing email">{data.account.billing_email ?? "owners"}</Row>
            <Row label="Company">{data.account.company_name ?? "—"}</Row>
            <Row label="KRA PIN">{data.account.tax_id ?? "—"}</Row>
            <Row label="M-Pesa number">{data.account.phone ?? "—"}{data.account.phone && !data.account.auto_collect ? " (prompts off)" : ""}</Row>
            <Row label="Website">{w.website ?? "—"}</Row>
            <Row label="Created">{day(w.created_at)}</Row>
          </dl>
          {w.use_case && <p className="mt-3 text-xs text-muted">Use case: {w.use_case}</p>}
        </Card>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-5 text-sm">
          <h3 className="mb-2 font-bold">Members</h3>
          <ul className="space-y-1">{data.members.map((m) => <li key={m.email} className="flex justify-between gap-2"><span>{m.name} · {m.email}</span><span className="text-subtle">{m.role.toLowerCase()}</span></li>)}</ul>
        </Card>
        <Card className="p-5 text-sm">
          <h3 className="mb-2 font-bold">Domains</h3>
          {data.domains.length === 0 ? <p className="text-muted">None yet.</p> : (
            <ul className="space-y-1">{data.domains.map((d) => <li key={d.name} className="flex justify-between gap-2"><span>{d.name}</span><StatusBadge status={d.status} /></li>)}</ul>
          )}
        </Card>
      </div>

      <h3 className="mb-3 font-bold">Invoices</h3>
      <Card className="mb-6">
        {data.invoices.length === 0 ? <EmptyState title="No invoices" /> : (
          <Table head={["Invoice", "For", "Issued", "Total", "Due", "Status", ""]}>
            {data.invoices.map((i) => (
              <tr key={i.id}>
                <td className="px-4 py-3 font-mono font-semibold">{i.number}</td>
                <td className="px-4 py-3">{PURPOSE_LABEL[i.purpose]}</td>
                <td className="px-4 py-3 text-muted">{day(i.created_at)}</td>
                <td className="px-4 py-3">{money(i.total, i.currency)}</td>
                <td className="px-4 py-3">{i.status === "open" ? `${money(i.amount_due, i.currency)} by ${day(i.due_at)}` : "—"}</td>
                <td className="px-4 py-3"><StatusBadge status={i.status} /></td>
                <td className="space-x-3 px-4 py-3 text-right">
                  <button type="button" className="font-semibold underline" onClick={() => openInvoice(i.id)}>View</button>
                  {i.status === "open" && (
                    <button type="button" className="font-semibold text-danger underline" onClick={() => quick(`Invoice ${i.number} voided.`, () => api(`/v1/admin/invoices/${i.id}/void`, { method: "POST" }))}>
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <h3 className="mb-3 font-bold">Payments</h3>
      <Card className="mb-6">
        {data.payments.length === 0 ? <EmptyState title="No payments" /> : (
          <Table head={["Date", "Invoice", "Method", "Amount", "Status", "Receipt", ""]}>
            {data.payments.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-3 text-muted">{formatDate(p.created_at)}</td>
                <td className="px-4 py-3 font-mono">{p.invoice_number ?? "—"}</td>
                <td className="px-4 py-3">{p.method_label}</td>
                <td className="px-4 py-3">{money(p.amount, p.currency)}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={p.status} />
                  {p.failure_message && <span className="block max-w-xs text-xs text-subtle">{p.failure_message}</span>}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{p.receipt ?? "—"}</td>
                <td className="px-4 py-3 text-right">
                  {p.status === "succeeded" && p.gateway !== "credit" && (
                    <button
                      type="button"
                      className="font-semibold underline"
                      onClick={() => {
                        const reason = window.prompt("Refund reason (the money must already be returned in the M-Pesa or bank portal):");
                        if (reason) void quick("Refund recorded.", () => api(`/v1/admin/payments/${p.id}/refund`, { method: "POST", body: { reason } }));
                      }}
                    >
                      Record refund
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <h3 className="mb-3 font-bold">Billing activity</h3>
      <Card className="p-5">
        {data.audit.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : (
          <ul className="space-y-1.5 text-sm">
            {data.audit.map((a, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2">
                <span><span className="font-mono text-xs">{a.action}</span> <span className="text-subtle">by {a.actor_type}</span> {a.metadata ? <span className="text-xs text-subtle">{JSON.stringify(a.metadata)}</span> : null}</span>
                <span className="text-xs text-subtle">{formatDate(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog open={action === "plan"} onClose={() => setAction(null)} title="Set plan" wide>
        {plans.data ? <PlanForm data={data} plans={plans.data.data} onDone={done} /> : <Spinner />}
      </Dialog>
      <Dialog open={action === "suspend"} onClose={() => setAction(null)} title="Suspend workspace">
        <SimpleForm
          intro="Suspended workspaces cannot send. Members can still sign in, see their data and pay invoices."
          fields={[{ name: "reason", label: "Reason (shown to the workspace)", type: "textarea", required: true }]}
          submitLabel="Suspend"
          onSubmit={(v) => api(`/v1/admin/workspaces/${w.id}/suspend`, { method: "POST", body: { reason: v.reason } })}
          onDone={done}
        />
      </Dialog>
      <Dialog open={action === "credit"} onClose={() => setAction(null)} title="Adjust account credit">
        <SimpleForm
          intro={`Current credit: ${money(data.account.credit_balance, e.currency)}. Credit is applied to the next invoices automatically.`}
          fields={[
            { name: "amount", label: "Amount in KES (negative to remove)", required: true },
            { name: "reason", label: "Reason", required: true },
          ]}
          submitLabel="Apply"
          onSubmit={(v) => api(`/v1/admin/workspaces/${w.id}/credit`, { method: "POST", body: { amount: toMinor(v.amount), reason: v.reason } })}
          onDone={done}
        />
      </Dialog>
      <Dialog open={action === "payment"} onClose={() => setAction(null)} title="Record a payment">
        <SimpleForm
          intro="For money received outside the console: bank transfers, cheques, cash, or an M-Pesa payment that was not matched automatically."
          fields={[
            { name: "invoice_id", label: "Invoice", type: "select", options: [["", "No invoice (add as credit)"], ...openInvoices.map((i): [string, string] => [i.id, `${i.number} · ${money(i.amount_due, i.currency)} due`])] },
            { name: "amount", label: "Amount in KES", required: true },
            { name: "method", label: "Method", type: "select", options: [["bank_transfer", "Bank transfer"], ["mpesa_paybill", "M-Pesa (by hand)"], ["cheque", "Cheque"], ["cash", "Cash"], ["other", "Other"]] },
            { name: "reference", label: "Reference (bank or M-Pesa receipt)", required: true },
            { name: "note", label: "Note", type: "textarea" },
          ]}
          submitLabel="Record payment"
          onSubmit={(v) =>
            api("/v1/admin/payments", {
              method: "POST",
              body: { organization_id: w.id, invoice_id: v.invoice_id || null, amount: toMinor(v.amount), currency: "KES", method: v.method, reference: v.reference, note: v.note || undefined },
            })
          }
          onDone={done}
        />
      </Dialog>
      <Dialog open={action === "invoice"} onClose={() => setAction(null)} title="Create an invoice">
        <SimpleForm
          intro="One line per row: description; amount in KES; quantity (optional). For example: Dedicated IP setup; 15000; 1"
          fields={[
            { name: "lines", label: "Lines", type: "textarea", required: true },
            { name: "due_days", label: "Days until due", hint: "Default 14" },
            { name: "notes", label: "Notes printed on the invoice", type: "textarea" },
          ]}
          submitLabel="Create and send"
          onSubmit={(v) => {
            const lines = v.lines.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
              const [description, amount, quantity] = l.split(";").map((p) => p.trim());
              return { description, unit_amount: toMinor(amount ?? "") ?? NaN, quantity: quantity ? Number(quantity) : 1 };
            });
            if (lines.some((l) => !l.description || Number.isNaN(l.unit_amount))) return Promise.reject(new Error("Each line needs a description and an amount, separated by ';'."));
            return api(`/v1/admin/workspaces/${w.id}/invoices`, { method: "POST", body: { lines, due_days: v.due_days ? Number(v.due_days) : 14, notes: v.notes || undefined } });
          }}
          onDone={done}
        />
      </Dialog>
      <Dialog open={viewing !== null} onClose={() => setViewing(null)} title={viewing ? `Invoice ${viewing.number}` : ""} wide>
        {viewing && (
          <div className="space-y-3 text-sm">
            <p><StatusBadge status={viewing.status} /> · {PURPOSE_LABEL[viewing.purpose]} · issued {day(viewing.created_at)} · due {day(viewing.due_at)}</p>
            <table className="w-full">
              <tbody className="divide-y divide-line">
                {viewing.lines.map((l, i) => (
                  <tr key={i}><td className="py-2 pr-3">{l.description}{l.quantity > 1 ? ` × ${count(l.quantity)}` : ""}</td><td className="py-2 text-right">{money(l.amount, viewing.currency)}</td></tr>
                ))}
                {viewing.tax > 0 && <tr><td className="py-2">{viewing.billing_details.taxLabel}</td><td className="py-2 text-right">{money(viewing.tax, viewing.currency)}</td></tr>}
                <tr><td className="py-2 font-bold">Total</td><td className="py-2 text-right font-bold">{money(viewing.total, viewing.currency)}</td></tr>
                <tr><td className="py-2">Paid</td><td className="py-2 text-right">{money(viewing.amount_paid, viewing.currency)}</td></tr>
              </tbody>
            </table>
            {viewing.payments.length > 0 && (
              <ul className="space-y-1">
                {viewing.payments.map((p) => <li key={p.id} className="flex justify-between"><span>{formatDate(p.created_at)} · {p.method_label} · {p.status}</span><span>{money(p.amount, p.currency)}</span></li>)}
              </ul>
            )}
            {viewing.notes && <p className="whitespace-pre-line text-muted">{viewing.notes}</p>}
          </div>
        )}
      </Dialog>
    </>
  );
}
