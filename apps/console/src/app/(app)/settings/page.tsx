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
  trackOpensDefault: boolean;
  trackClicksDefault: boolean;
  sendingApproved: boolean;
  sendingReviewRequestedAt: string | null;
  unapprovedDailyLimit: number | null;
}

export default function GeneralSettingsPage() {
  const { can, refreshMe } = useWorkspace();
  const { data, mutate } = useApi<WorkspaceDetail>("/v1/workspace");
  const [name, setName] = useState("");
  const [useCase, setUseCase] = useState("");
  const [website, setWebsite] = useState("");
  const [trackOpens, setTrackOpens] = useState(false);
  const [trackClicks, setTrackClicks] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [reviewResult, setReviewResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setUseCase(data.useCase ?? "");
    setWebsite(data.website ?? "");
    setTrackOpens(data.trackOpensDefault);
    setTrackClicks(data.trackClicksDefault);
  }, [data]);

  if (!data) return <Spinner />;

  async function requestReview() {
    setRequesting(true);
    setReviewResult(null);
    try {
      await api("/v1/workspace/request-review", { method: "POST" });
      await mutate();
      setReviewResult({ ok: true, message: "Review requested. We check new workspaces and will be in touch." });
    } catch (err) {
      setReviewResult({ ok: false, message: errorMessage(err) });
    } finally {
      setRequesting(false);
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      await api("/v1/workspace", {
        method: "PATCH",
        body: { name, use_case: useCase || undefined, website: website || undefined, track_opens_default: trackOpens, track_clicks_default: trackClicks },
      });
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
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-semibold">Tracking</legend>
            <p className="text-sm text-muted">
              Used when an email does not set <span className="font-mono">track_opens</span> or <span className="font-mono">track_clicks</span>. Click
              tracking never rewrites password-reset, verification or sign-in links.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-orange" disabled={!can.manageMembers} checked={trackOpens} onChange={(e) => setTrackOpens(e.target.checked)} />
              Track opens (adds an invisible image)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-orange" disabled={!can.manageMembers} checked={trackClicks} onChange={(e) => setTrackClicks(e.target.checked)} />
              Track clicks (links go through TredMail&apos;s tracking address)
            </label>
          </fieldset>
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
      <Card className="h-fit p-5 text-sm">
        <h2 className="mb-3 font-bold">Sending approval</h2>
        {data.sendingApproved ? (
          <>
            <Badge tone="accent">Approved</Badge>
            <p className="mt-3 text-muted">This workspace can send from its own domains without the new-workspace daily limit.</p>
          </>
        ) : (
          <>
            <p className="text-muted">
              New workspaces can send from their own domains up to {data.unapprovedDailyLimit?.toLocaleString("en-US") ?? "a few hundred"} emails a day until
              we have reviewed them. This protects the shared sending IP for every customer.
            </p>
            {data.sendingReviewRequestedAt ? (
              <p className="mt-3 text-muted">Review requested on {new Date(data.sendingReviewRequestedAt).toLocaleDateString("en-GB")}.</p>
            ) : (
              can.manageMembers && (
                <Button className="mt-3" size="sm" loading={requesting} onClick={requestReview}>
                  Request review
                </Button>
              )
            )}
            {reviewResult && <Alert tone={reviewResult.ok ? "success" : "danger"}>{reviewResult.message}</Alert>}
          </>
        )}
      </Card>
    </div>
  );
}
