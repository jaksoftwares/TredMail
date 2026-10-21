"use client";

import { useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/workspace";
import { count, limitLabel, money } from "@/lib/billing";
import { toMajor, toMinor, type AdminPlan } from "@/lib/admin";
import { Alert, Badge, Button, Card, Dialog, Field, Input, Spinner, Table, Textarea } from "@/components/ui";

type Form = Record<string, string | boolean>;

function toForm(p?: AdminPlan): Form {
  return {
    id: p?.id ?? "",
    name: p?.name ?? "",
    description: p?.description ?? "",
    price_monthly: toMajor(p?.price_monthly ?? 0),
    price_yearly: toMajor(p?.price_yearly),
    monthly_emails: String(p?.monthly_emails ?? 0),
    daily_emails: String(p?.daily_emails ?? 0),
    overage_price_per_1000: toMajor(p?.overage_price_per_1000),
    overage_limit: p?.overage_limit?.toString() ?? "",
    max_domains: String(p?.max_domains ?? 0),
    max_members: String(p?.max_members ?? 0),
    log_retention_days: String(p?.log_retention_days ?? 30),
    features: (p?.features ?? []).join("\n"),
    sort_order: String(p?.sort_order ?? 0),
    is_public: p?.is_public ?? true,
    is_active: p?.is_active ?? true,
  };
}

function PlanEditor({ plan, onDone }: { plan: AdminPlan | null; onDone: () => void }) {
  const [form, setForm] = useState<Form>(toForm(plan ?? undefined));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const text = (k: string) => form[k] as string;
  const int = (k: string) => Number(text(k).replace(/[,\s]/g, "") || 0);
  const nullableInt = (k: string) => (text(k).trim() === "" ? null : int(k));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: text("name"),
      description: text("description") || null,
      price_monthly: toMinor(text("price_monthly")) ?? 0,
      price_yearly: toMinor(text("price_yearly")),
      monthly_emails: int("monthly_emails"),
      daily_emails: int("daily_emails"),
      overage_price_per_1000: toMinor(text("overage_price_per_1000")),
      overage_limit: nullableInt("overage_limit"),
      max_domains: int("max_domains"),
      max_members: int("max_members"),
      log_retention_days: int("log_retention_days"),
      features: text("features").split("\n").map((f) => f.trim()).filter(Boolean),
      sort_order: int("sort_order"),
      is_public: form.is_public,
      is_active: form.is_active,
    };
    try {
      if (plan) await api(`/v1/admin/plans/${plan.id}`, { method: "PATCH", body });
      else await api("/v1/admin/plans", { method: "POST", body: { ...body, id: text("id") } });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const input = (k: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input value={text(k)} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </Field>
  );

  return (
    <form onSubmit={save} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {plan && <Alert tone="info">Price changes apply to renewals issued from now on; invoices already issued keep their amounts.</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        {!plan && input("id", "Plan id", "Lowercase, e.g. growth")}
        {input("name", "Name")}
        {input("price_monthly", "Monthly price (KES)")}
        {input("price_yearly", "Yearly price (KES)", "Empty = no yearly option")}
        {input("monthly_emails", "Emails per month", "0 = unlimited")}
        {input("daily_emails", "Emails per day", "0 = no daily cap")}
        {input("overage_price_per_1000", "Extra emails, KES per 1,000", "Empty = stop at the allowance")}
        {input("overage_limit", "Most extra emails per month", "Empty = no limit")}
        {input("max_domains", "Max domains", "0 = unlimited")}
        {input("max_members", "Max members", "0 = unlimited")}
        {input("log_retention_days", "Days of email logs")}
        {input("sort_order", "Order", "Higher = bigger plan (decides upgrade vs downgrade)")}
      </div>
      {input("description", "Description")}
      <Field label="Features (one per line)">
        <Textarea rows={4} value={text("features")} onChange={(e) => setForm({ ...form, features: e.target.value })} />
      </Field>
      <div className="flex gap-6 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_public as boolean} onChange={(e) => setForm({ ...form, is_public: e.target.checked })} /> Shown in the plan picker</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_active as boolean} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Active</label>
      </div>
      <Button type="submit" loading={busy}>{plan ? "Save plan" : "Create plan"}</Button>
    </form>
  );
}

export default function AdminPlansPage() {
  const { data, mutate } = useApi<{ data: AdminPlan[] }>("/v1/admin/plans");
  const [editing, setEditing] = useState<AdminPlan | "new" | null>(null);
  if (!data) return <Spinner />;
  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setEditing("new")}>New plan</Button>
      </div>
      <Card>
        <Table head={["Plan", "Price", "Emails", "Limits", "Workspaces", ""]}>
          {data.data.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-3">
                <span className="font-semibold">{p.name}</span> <span className="font-mono text-xs text-subtle">{p.id}</span>
                <div className="mt-1 space-x-1">
                  {!p.is_public && <Badge>hidden</Badge>}
                  {!p.is_active && <Badge tone="danger">inactive</Badge>}
                </div>
              </td>
              <td className="px-4 py-3">
                {p.price_monthly ? `${money(p.price_monthly, p.currency)} / month` : "Free or custom"}
                {p.price_yearly ? <span className="block text-xs text-subtle">{money(p.price_yearly, p.currency)} / year</span> : null}
              </td>
              <td className="px-4 py-3">
                {limitLabel(p.monthly_emails, "a month")}
                {p.overage_price_per_1000 !== null && <span className="block text-xs text-subtle">+ {money(p.overage_price_per_1000, p.currency)} per 1,000 extra</span>}
              </td>
              <td className="px-4 py-3 text-xs">{limitLabel(p.max_domains, "domains")} · {limitLabel(p.max_members, "members")} · {p.log_retention_days} days logs</td>
              <td className="px-4 py-3">{count(p.workspaces)}</td>
              <td className="px-4 py-3 text-right"><button type="button" className="font-semibold underline" onClick={() => setEditing(p)}>Edit</button></td>
            </tr>
          ))}
        </Table>
      </Card>
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "New plan" : `Edit ${editing?.name ?? ""}`} wide>
        {editing !== null && <PlanEditor plan={editing === "new" ? null : editing} onDone={() => { setEditing(null); void mutate(); }} />}
      </Dialog>
    </>
  );
}
