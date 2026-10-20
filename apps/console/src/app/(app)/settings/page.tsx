"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Badge, Button, Card, Field, Input, Spinner, Textarea } from "@/components/ui";

interface WorkspaceDetail {
  id: string;
  name: string;
  slug: string;
  plan: string;
  planName: string;
  monthlyQuota: number;
  useCase: string | null;
  website: string | null;
}

export default function GeneralSettingsPage() {
  const { can, refreshMe } = useWorkspace();
  const { data, mutate } = useApi<WorkspaceDetail>("/v1/workspace");
  const [name, setName] = useState("");
  const [useCase, setUseCase] = useState("");
  const [website, setWebsite] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setUseCase(data.useCase ?? "");
    setWebsite(data.website ?? "");
  }, [data]);

  if (!data) return <Spinner />;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      await api("/v1/workspace", { method: "PATCH", body: { name, use_case: useCase || undefined, website: website || undefined } });
      await Promise.all([mutate(), refreshMe()]);
      setResult({ ok: true, message: "Saved." });
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <Card className="p-5">
        <form onSubmit={onSave} className="space-y-4">
          <h2 className="font-bold">Workspace details</h2>
          {result && <Alert tone={result.ok ? "success" : "danger"}>{result.message}</Alert>}
          <Field label="Name">
            <Input required minLength={2} maxLength={60} disabled={!can.manageMembers} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="What you send">
            <Textarea rows={3} maxLength={500} disabled={!can.manageMembers} value={useCase} onChange={(e) => setUseCase(e.target.value)} />
          </Field>
          <Field label="Website">
            <Input type="url" disabled={!can.manageMembers} value={website} onChange={(e) => setWebsite(e.target.value)} />
          </Field>
          {can.manageMembers && <Button type="submit" loading={saving}>Save changes</Button>}
        </form>
      </Card>
      <Card className="h-fit p-5 text-sm">
        <h2 className="mb-3 font-bold">Plan</h2>
        <Badge tone="accent">{data.planName}</Badge>
        <p className="mt-3 text-muted">
          {data.monthlyQuota === 0 ? "No monthly sending limit." : `${data.monthlyQuota.toLocaleString()} emails per month.`}
        </p>
        {can.viewBilling && (
          <Link href="/billing" className="mt-3 inline-block font-semibold text-navy underline">
            Plans, usage and invoices
          </Link>
        )}
        <p className="mt-3 text-xs text-subtle">Workspace ID: <span className="font-mono">{data.id}</span></p>
      </Card>
    </div>
  );
}
