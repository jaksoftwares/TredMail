"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import {
  count,
  day,
  limitLabel,
  money,
  perMonth,
  PURPOSE_LABEL,
  type BillingOverview,
  type Invoice,
  type InvoiceSummary,
  type Payment,
  type Plan,
} from "@/lib/billing";
import { PayInvoiceDialog } from "@/components/pay-invoice";
import { UsageMeter } from "@/components/usage-meter";
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Spinner, StatusBadge, Table } from "@/components/ui";

type Interval = "month" | "year";

interface Preview {
  change: "upgrade" | "downgrade";
  effective: "now" | "period_end";
  effective_at: string;
  plan: Plan;
  interval: Interval;
  currency: string;
  lines: Array<{ kind: string; description: string; quantity: number; amount: number }>;
  subtotal: number;
  tax: number;
  total: number;
  credit_to_balance: number;
}

function PlanCard({
  plan,
  interval,
  current,
  canManage,
  onChoose,
}: {
  plan: Plan;
  interval: Interval;
  current: boolean;
  canManage: boolean;
  onChoose: () => void;
}) {
  const unavailable = interval === "year" && plan.price_yearly === null && plan.price_monthly > 0;
  const price = perMonth(plan, interval);
  return (
    <Card className={`flex flex-col p-5 ${current ? "border-orange shadow-[inset_0_3px_0_var(--color-orange)]" : ""}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-lg font-bold text-navy">{plan.name}</h3>
        {current && <Badge tone="accent">Current plan</Badge>}
      </div>
      <p className="text-2xl font-extrabold text-navy">
        {plan.price_monthly === 0 ? "Free" : money(price, plan.currency)}
        {plan.price_monthly > 0 && <span className="text-sm font-semibold text-muted"> / month</span>}
      </p>
      <p className="mb-4 h-5 text-xs text-subtle">
        {interval === "year" && plan.price_yearly ? `${money(plan.price_yearly, plan.currency)} billed yearly` : plan.price_monthly > 0 ? "billed monthly" : ""}
      </p>
      {plan.description && <p className="mb-3 text-sm text-muted">{plan.description}</p>}
      <ul className="mb-5 flex-1 space-y-1.5 text-sm">
        {plan.features.map((f) => (
          <li key={f} className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-green" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {canManage && !current && (
        <Button variant={plan.price_monthly === 0 ? "secondary" : "primary"} onClick={onChoose} disabled={unavailable}>
          {unavailable ? "Monthly only" : plan.price_monthly === 0 ? "Move to Free" : `Choose ${plan.name}`}
        </Button>
      )}
    </Card>
  );
}

function BillingDetailsForm({ data, onSaved }: { data: BillingOverview; onSaved: () => void }) {
  const a = data.account;
  const [form, setForm] = useState({
    phone: "",
    auto_collect: true,
    billing_email: "",
    company_name: "",
    tax_id: "",
    address_line1: "",
    address_line2: "",
    city: "",
    country: "KE",
  });
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    setForm({
      phone: a.phone ? `0${a.phone.slice(3)}` : "",
      auto_collect: a.auto_collect,
      billing_email: a.billing_email ?? "",
      company_name: a.company_name ?? "",
      tax_id: a.tax_id ?? "",
      address_line1: a.address_line1 ?? "",
      address_line2: a.address_line2 ?? "",
      city: a.city ?? "",
      country: a.country,
    });
  }, [a]);
  const disabled = !data.can_manage;
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      await api("/v1/billing/account", { method: "PUT", body: { ...form, phone: form.phone || null } });
      setResult({ ok: true, message: "Saved." });
      onSaved();
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      {result && <Alert tone={result.ok ? "success" : "danger"}>{result.message}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="M-Pesa phone number" hint="Payment requests for renewals go to this number.">
          <Input type="tel" inputMode="tel" placeholder="0712 345 678" disabled={disabled} value={form.phone} onChange={set("phone")} />
        </Field>
        <Field label="Billing email" hint="Invoices and receipts also go to the workspace owners.">
          <Input type="email" disabled={disabled} value={form.billing_email} onChange={set("billing_email")} />
        </Field>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--color-orange)]"
          disabled={disabled}
          checked={form.auto_collect}
          onChange={(e) => setForm({ ...form, auto_collect: e.target.checked })}
        />
        <span>
          <span className="font-semibold text-navy">Send the payment request to my phone when a renewal is due</span>
          <span className="block text-xs text-subtle">You approve each payment with your M-Pesa PIN. Requests are only sent between 08:00 and 20:00.</span>
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name (on invoices)">
          <Input disabled={disabled} value={form.company_name} onChange={set("company_name")} />
        </Field>
        <Field label="KRA PIN or tax number">
          <Input disabled={disabled} value={form.tax_id} onChange={set("tax_id")} />
        </Field>
        <Field label="Address">
          <Input disabled={disabled} value={form.address_line1} onChange={set("address_line1")} />
        </Field>
        <Field label="Address line 2">
          <Input disabled={disabled} value={form.address_line2} onChange={set("address_line2")} />
        </Field>
        <Field label="City">
          <Input disabled={disabled} value={form.city} onChange={set("city")} />
        </Field>
        <Field label="Country code">
          <Input disabled={disabled} maxLength={2} value={form.country} onChange={set("country")} />
        </Field>
      </div>
      {data.can_manage && <Button type="submit" loading={saving}>Save billing details</Button>}
    </form>
  );
}

export default function BillingPage() {
  const { can, refreshMe } = useWorkspace();
  const { data, mutate } = useApi<BillingOverview>(can.viewBilling ? "/v1/billing" : null);
  const invoices = useApi<{ data: InvoiceSummary[] }>(can.viewBilling ? "/v1/billing/invoices" : null);
  const payments = useApi<{ data: Payment[] }>(can.viewBilling ? "/v1/billing/payments" : null);
  const [interval, setBillingInterval] = useState<Interval>("month");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [paying, setPaying] = useState<Invoice | null>(null);

  useEffect(() => {
    if (data) setBillingInterval(data.subscription.interval);
  }, [data?.subscription.interval]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!can.viewBilling) {
    return (
      <>
        <PageHeader title="Billing" />
        <Card><EmptyState title="Billing is for workspace Owners and Admins" description="Ask an Owner of this workspace if you need an invoice or a plan change." /></Card>
      </>
    );
  }
  if (!data) return <Spinner />;

  const reload = () => Promise.all([mutate(), invoices.mutate(), payments.mutate(), refreshMe()]);
  const { subscription: sub, usage, entitlements: ent } = data;
  const isPaid = ent.price > 0;
  const managedPlan = !data.plans.some((p) => p.id === sub.plan.id);

  async function choose(plan: Plan) {
    setPreviewError(null);
    setNotice(null);
    try {
      setPreview(await api<Preview>("/v1/billing/preview", { method: "POST", body: { plan: plan.id, interval } }));
    } catch (err) {
      setNotice({ ok: false, message: errorMessage(err) });
    }
  }

  async function openPayment(invoiceId: string) {
    try {
      setPaying(await api<Invoice>(`/v1/billing/invoices/${invoiceId}`));
    } catch (err) {
      setNotice({ ok: false, message: errorMessage(err) });
    }
  }

  async function confirm() {
    if (!preview) return;
    setConfirming(true);
    setPreviewError(null);
    try {
      const result = await api<{ effective: string; paid?: boolean; effective_at?: string; invoice: InvoiceSummary | null }>("/v1/billing/subscription", {
        method: "POST",
        body: { plan: preview.plan.id, interval: preview.interval },
      });
      setPreview(null);
      await reload();
      if (result.effective === "period_end") {
        setNotice({ ok: true, message: `Scheduled: the workspace moves to ${preview.plan.name} on ${day(result.effective_at)}.` });
      } else if (result.paid) {
        setNotice({ ok: true, message: `You are now on the ${preview.plan.name} plan.` });
      } else if (result.invoice) {
        await openPayment(result.invoice.id);
      }
    } catch (err) {
      setPreviewError(errorMessage(err));
    } finally {
      setConfirming(false);
    }
  }

  async function keepPlan() {
    try {
      await api("/v1/billing/subscription/keep", { method: "POST" });
      setNotice({ ok: true, message: `You stay on the ${sub.plan.name} plan.` });
      await reload();
    } catch (err) {
      setNotice({ ok: false, message: errorMessage(err) });
    }
  }

  const overdue = data.open_invoices.filter((i) => new Date(i.due_at) <= new Date());
  const hasYearly = data.plans.some((p) => p.price_yearly !== null);

  return (
    <>
      <PageHeader title="Billing" description="Your plan, usage, invoices and payments. Pay with M-Pesa from here, or by Paybill using your invoice number." />

      <div className="mb-6 space-y-3">
        {notice && <Alert tone={notice.ok ? "success" : "danger"}>{notice.message}</Alert>}
        {data.standing.suspended && <Alert tone="danger">This workspace is suspended{data.standing.suspended_reason ? `: ${data.standing.suspended_reason}` : ""}. Contact Dovepeak Technologies support.</Alert>}
        {data.standing.sending_paused && <Alert tone="danger">Sending is paused: {data.standing.sending_pause_reason}. Contact support once the cause is fixed.</Alert>}
        {sub.status === "past_due" && (
          <Alert tone="danger">
            A payment is overdue. Sending continues on the {sub.plan.name} plan for now; pay the open invoice to keep it.
          </Alert>
        )}
        {data.open_invoices.map((invoice) => (
          <Card key={invoice.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <p className="font-bold text-navy">
                {PURPOSE_LABEL[invoice.purpose]} · {money(invoice.amount_due, invoice.currency)} due {day(invoice.due_at)}
                {overdue.includes(invoice) && <span className="ml-2"><Badge tone="danger">overdue</Badge></span>}
              </p>
              <p className="text-muted">
                Invoice <Link href={`/billing/invoices/${invoice.id}`} className="font-mono font-semibold underline">{invoice.number}</Link>
              </p>
            </div>
            <div className="flex gap-2">
              <Link href={`/billing/invoices/${invoice.id}`}><Button variant="secondary">View</Button></Link>
              <Button onClick={() => openPayment(invoice.id)}>Pay now</Button>
            </div>
          </Card>
        ))}
      </div>

      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-subtle">Current plan</p>
              <h2 className="text-xl font-bold text-navy">{sub.plan.name}</h2>
            </div>
            <StatusBadge status={sub.status} />
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Price</dt>
              <dd className="font-semibold">{isPaid ? `${money(ent.price, ent.currency)} per ${ent.interval}` : "Free"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">{isPaid ? "Current period" : "Allowance period"}</dt>
              <dd className="font-semibold">{day(sub.current_period_start)} to {day(sub.current_period_end)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Limits</dt>
              <dd className="text-right font-semibold">
                {limitLabel(ent.max_domains, ent.max_domains === 1 ? "domain" : "domains")} · {limitLabel(ent.max_members, "members")} · {ent.log_retention_days} days of logs
              </dd>
            </div>
            {data.account.credit_balance > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Account credit</dt>
                <dd className="font-semibold text-green">{money(data.account.credit_balance, ent.currency)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Paybill account number</dt>
              <dd className="font-mono font-semibold">{data.account.account_code}</dd>
            </div>
          </dl>
          {sub.pending_change && (
            <div className="mt-4 rounded-md bg-info-50 p-3 text-sm text-info">
              Moves to <strong>{sub.pending_change.plan_name}</strong> on {day(sub.pending_change.effective_at)}.
              {data.can_manage && (
                <button type="button" onClick={keepPlan} className="ml-2 font-semibold underline">
                  Keep {sub.plan.name}
                </button>
              )}
            </div>
          )}
          {managedPlan && <p className="mt-4 text-xs text-subtle">This plan is arranged with Dovepeak. Contact your account manager to change it.</p>}
        </Card>

        <Card className="space-y-5 p-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-subtle">Usage this month</p>
            <p className="text-sm text-muted">
              {day(usage.period_start)} to {day(usage.period_end)} · every recipient (to, cc, bcc) counts once
            </p>
          </div>
          <UsageMeter
            label="Emails this month"
            used={usage.emails_sent}
            limit={usage.monthly_limit}
            note={
              usage.overage_emails > 0 && ent.overage_price_per_1000 !== null
                ? `${count(usage.overage_emails)} extra emails so far, billed at ${money(ent.overage_price_per_1000, ent.currency)} per 1,000 at month end.`
                : usage.monthly_limit > 0 && ent.overage_price_per_1000 === null
                  ? "Sending stops at the allowance until it resets. Upgrade for more."
                  : undefined
            }
          />
          <UsageMeter label="Emails today (UTC)" used={usage.emails_today} limit={usage.daily_limit} />
        </Card>
      </div>

      {!managedPlan && (
        <section className="mb-8">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-navy">Plans</h2>
            {hasYearly && (
              <div className="inline-flex rounded-md border border-line bg-surface p-0.5 text-sm" role="group" aria-label="Billing interval">
                {(["month", "year"] as const).map((i) => (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={interval === i}
                    onClick={() => setBillingInterval(i)}
                    className={`rounded px-3 py-1.5 font-semibold ${interval === i ? "bg-navy text-offwhite" : "text-muted hover:text-navy"}`}
                  >
                    {i === "month" ? "Monthly" : "Yearly (2 months free)"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {data.plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                interval={interval}
                current={plan.id === sub.plan.id && (plan.price_monthly === 0 || interval === sub.interval)}
                canManage={data.can_manage}
                onChoose={() => choose(plan)}
              />
            ))}
          </div>
          <p className="mt-3 text-xs text-subtle">
            Prices in Kenyan shillings. Upgrades start immediately and are charged now, less a credit for unused time on your current plan. Downgrades take effect at the end of the period you have paid for.
            Need more volume, a dedicated IP or invoiced terms? <a href="https://dovepeakdigital.com" className="font-semibold underline">Talk to Dovepeak</a> about Enterprise.
          </p>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-4 text-lg font-bold text-navy">Payment and billing details</h2>
        <Card className="p-5">
          <BillingDetailsForm data={data} onSaved={() => mutate()} />
        </Card>
      </section>

      <section className="mb-8">
        <h2 className="mb-4 text-lg font-bold text-navy">Invoices</h2>
        <Card>
          {!invoices.data ? (
            <Spinner />
          ) : invoices.data.data.length === 0 ? (
            <EmptyState title="No invoices yet" description="Invoices appear here when you upgrade or a paid plan renews." />
          ) : (
            <Table head={["Invoice", "For", "Date", "Total", "Status", ""]}>
              {invoices.data.data.map((i) => (
                <tr key={i.id}>
                  <td className="px-4 py-3 font-mono font-semibold">{i.number}</td>
                  <td className="px-4 py-3">{PURPOSE_LABEL[i.purpose]}</td>
                  <td className="px-4 py-3 text-muted">{day(i.created_at)}</td>
                  <td className="px-4 py-3 font-semibold">{money(i.total, i.currency)}</td>
                  <td className="px-4 py-3"><StatusBadge status={i.status} /></td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/billing/invoices/${i.id}`} className="font-semibold text-navy underline">View</Link>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-bold text-navy">Payments</h2>
        <Card>
          {!payments.data ? (
            <Spinner />
          ) : payments.data.data.length === 0 ? (
            <EmptyState title="No payments yet" />
          ) : (
            <Table head={["Date", "Invoice", "Method", "Amount", "Status", "Receipt"]}>
              {payments.data.data.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3 text-muted">{day(p.created_at)}</td>
                  <td className="px-4 py-3 font-mono">{p.invoice_number ?? "credit"}</td>
                  <td className="px-4 py-3">{p.method_label}</td>
                  <td className="px-4 py-3 font-semibold">{money(p.amount, p.currency)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                    {p.status === "failed" && p.failure_message && <span className="mt-1 block max-w-xs text-xs text-subtle">{p.failure_message}</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{p.receipt ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </section>

      <Dialog open={preview !== null} onClose={() => setPreview(null)} title={preview ? `Switch to ${preview.plan.name}` : ""}>
        {preview && (
          <div className="space-y-4 text-sm">
            {previewError && <Alert tone="danger">{previewError}</Alert>}
            {preview.effective === "period_end" ? (
              <p>
                {preview.plan.price_monthly === 0 ? "Your workspace moves to the Free plan" : `Your workspace moves to ${preview.plan.name}`} on <strong>{day(preview.effective_at)}</strong>, when the period you paid for ends.
                Nothing is charged now. {preview.plan.price_monthly > 0 && "The renewal invoice will be for the new plan."}
              </p>
            ) : (
              <>
                <p>The {preview.plan.name} plan starts as soon as the payment goes through.</p>
                <table className="w-full">
                  <tbody className="divide-y divide-line">
                    {preview.lines.map((l, i) => (
                      <tr key={i}>
                        <td className="py-2 pr-3">{l.description}</td>
                        <td className={`py-2 text-right font-semibold ${l.amount < 0 ? "text-green" : ""}`}>{money(l.amount, preview.currency)}</td>
                      </tr>
                    ))}
                    {preview.tax > 0 && (
                      <tr>
                        <td className="py-2 pr-3 text-muted">Tax</td>
                        <td className="py-2 text-right">{money(preview.tax, preview.currency)}</td>
                      </tr>
                    )}
                    <tr>
                      <td className="py-2 pr-3 font-bold">Total due now</td>
                      <td className="py-2 text-right text-base font-extrabold">{money(preview.total, preview.currency)}</td>
                    </tr>
                  </tbody>
                </table>
                {preview.credit_to_balance > 0 && (
                  <p className="text-xs text-subtle">The remaining {money(preview.credit_to_balance, preview.currency)} of unused time is kept as account credit.</p>
                )}
                {data.account.credit_balance > 0 && <p className="text-xs text-subtle">Your account credit of {money(data.account.credit_balance, ent.currency)} is applied to the invoice.</p>}
              </>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setPreview(null)}>Cancel</Button>
              <Button onClick={confirm} loading={confirming}>
                {preview.effective === "now" ? "Continue to payment" : "Schedule change"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {paying && (
        <PayInvoiceDialog
          open
          onClose={() => {
            setPaying(null);
            void reload();
          }}
          invoice={paying}
          gateways={paying.pay_with}
          offline={paying.pay_offline}
          defaultPhone={data.account.phone}
          onPaid={() => void reload()}
        />
      )}
    </>
  );
}
