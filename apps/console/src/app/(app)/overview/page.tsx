"use client";

import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, Circle, Send } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Button, Card, EmptyState, PageHeader, Select, Spinner, StatusBadge, Table, formatDate } from "@/components/ui";
import { DailyChart, type DayPoint } from "@/components/daily-chart";
import { UsageMeter } from "@/components/usage-meter";
import { day, type Entitlements, type Usage } from "@/lib/billing";

interface Stats {
  metrics: {
    totalEmails: number;
    acceptedCount: number;
    deliveredCount: number;
    bouncedCount: number;
    failedCount: number;
    uniqueOpens: number;
    acceptedRate: string;
    openRate: string;
    clickRate: string;
    bounceRate: string;
  };
  recentEmails: { id: string; from: string; to: string[]; subject: string; status: string; createdAt: string }[];
}

interface DomainStats {
  domain: string;
  total: number;
  delivered?: number;
  bounced?: number;
  complained?: number;
  delivery_rate: string | null;
  bounce_rate: string | null;
}

interface ListResponse<T> {
  data: T[];
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{label}</p>
      <p className="mt-1 text-2xl font-bold text-navy">{value}</p>
      <p className="mt-0.5 text-xs text-muted">{detail}</p>
    </Card>
  );
}

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 py-3">
      {done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green" /> : <Circle className="mt-0.5 size-5 shrink-0 text-navy-200" />}
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-semibold ${done ? "text-muted line-through decoration-navy-200" : "text-navy"}`}>{title}</p>
        {!done && children && <div className="mt-1.5 text-sm text-muted">{children}</div>}
      </div>
    </li>
  );
}

export default function OverviewPage() {
  const { me, workspace, can } = useWorkspace();
  const stats = useApi<Stats>("/v1/stats");
  const domains = useApi<ListResponse<{ status: string }>>("/v1/domains");
  const keys = useApi<ListResponse<{ revokedAt: string | null }>>(can.manageKeys ? "/v1/api-keys" : null);
  const webhooks = useApi<ListResponse<unknown>>(can.manageWebhooks ? "/v1/webhooks" : null);
  const members = useApi<ListResponse<unknown>>("/v1/members");
  const [days, setDays] = useState(30);
  const series = useApi<{ data: DayPoint[] }>(`/v1/stats/timeseries?days=${days}`);
  const perDomain = useApi<{ data: DomainStats[] }>(`/v1/stats/domains?days=${days}`);
  const { data: usage } = useApi<Usage & { plan: Entitlements }>("/v1/usage");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function sendTest() {
    setSending(true);
    setSendResult(null);
    try {
      await api("/v1/onboarding/test-email", { method: "POST", body: {} });
      setSendResult({ ok: true, message: `Sent to ${me.user.email}. Check your inbox.` });
      stats.mutate();
    } catch (err) {
      setSendResult({ ok: false, message: errorMessage(err) });
    } finally {
      setSending(false);
    }
  }

  if (!stats.data) return <Spinner />;
  const m = stats.data.metrics;

  const steps = {
    sent: m.totalEmails > 0,
    domain: (domains.data?.data.length ?? 0) > 0,
    verified: domains.data?.data.some((d) => d.status === "verified") ?? false,
    key: (keys.data?.data.filter((k) => !k.revokedAt).length ?? 0) > 0,
    webhook: (webhooks.data?.data.length ?? 0) > 0,
    team: (members.data?.data.length ?? 0) > 1,
  };
  const remaining = Object.values(steps).filter((d) => !d).length;

  return (
    <>
      <PageHeader title="Overview" description={`Sending activity for ${workspace.name}.`} />

      {remaining > 0 && (
        <Card className="mb-6 p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold">Get started</h2>
            <span className="text-xs font-semibold text-subtle">{6 - remaining} of 6 done</span>
          </div>
          <ol className="mt-2 divide-y divide-line">
            <Step done={steps.sent} title="Send your first email">
              <p className="mb-2">
                Send a test from <span className="font-mono text-xs">{me.sandbox_sender}</span> to yourself. No DNS needed.
              </p>
              {can.send && (
                <Button size="sm" onClick={sendTest} loading={sending}>
                  <Send className="size-3.5" />
                  Send test email
                </Button>
              )}
              {sendResult && <div className="mt-2"><Alert tone={sendResult.ok ? "success" : "danger"}>{sendResult.message}</Alert></div>}
            </Step>
            <Step done={steps.domain} title="Add your sending domain">
              <Link href="/domains" className="font-semibold text-navy underline">Add a domain</Link> to send from your own address.
            </Step>
            <Step done={steps.verified} title="Verify the domain's DNS records">
              Publish the DKIM, SPF and DMARC records, then press Verify on the domain page.
            </Step>
            <Step done={steps.key} title="Create an API key">
              {can.manageKeys ? <Link href="/api-keys" className="font-semibold text-navy underline">Create a key</Link> : "Ask a workspace admin for an API key."}{" "}
              for your application.
            </Step>
            <Step done={steps.webhook} title="Receive delivery events">
              {can.manageKeys ? <Link href="/webhooks" className="font-semibold text-navy underline">Add a webhook</Link> : "An admin can add a webhook"} to hear about bounces and opens.
            </Step>
            <Step done={steps.team} title="Invite your team">
              {can.manageMembers ? <Link href="/settings/members" className="font-semibold text-navy underline">Invite teammates</Link> : "Admins can invite teammates"} to share this workspace.
            </Step>
          </ol>
        </Card>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Emails" value={m.totalEmails} detail={`${m.acceptedCount} accepted by the mail server`} />
        <Metric label="Open rate" value={m.openRate} detail={`${m.uniqueOpens} emails opened`} />
        <Metric label="Bounce rate" value={m.bounceRate} detail={`${m.bouncedCount} bounced`} />
        <Metric label="Failed" value={m.failedCount} detail="Not accepted after all retries" />
      </div>

      {usage && (
        <Card className="mb-6 flex flex-col gap-4 p-5 md:flex-row md:items-center">
          <div className="md:w-56">
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{usage.plan.plan_name} plan</p>
            <p className="text-sm text-muted">Resets {day(usage.period_end)}</p>
            {can.viewBilling && (
              <Link href="/billing" className="text-sm font-semibold text-navy underline">
                {usage.plan.price === 0 ? "Upgrade" : "Billing"}
              </Link>
            )}
          </div>
          <div className="grid flex-1 gap-4 sm:grid-cols-2">
            <UsageMeter label="Emails this month" used={usage.emails_sent} limit={usage.monthly_limit} />
            <UsageMeter label="Today" used={usage.emails_today} limit={usage.daily_limit} />
          </div>
        </Card>
      )}

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="font-bold">Delivered per day</h2>
            {series.data && (
              <p className="text-xs text-muted">
                {series.data.data.reduce((sum, d) => sum + d.delivered, 0).toLocaleString()} delivered,{" "}
                {series.data.data.reduce((sum, d) => sum + d.bounced, 0).toLocaleString()} bounced,{" "}
                {series.data.data.reduce((sum, d) => sum + d.complained, 0).toLocaleString()} spam complaints in the last {days} days (UTC)
              </p>
            )}
          </div>
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="max-w-36" aria-label="Period">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
        </div>
        <div className="p-4">{series.data ? <DailyChart data={series.data.data} /> : <Spinner />}</div>
        {perDomain.data && perDomain.data.data.length > 0 && (
          <Table head={["Domain", "Emails", "Status delivered", "Delivery rate", "Bounce rate"]}>
            {perDomain.data.data.map((d) => (
              <tr key={d.domain}>
                <td className="px-4 py-2 font-semibold text-navy">{d.domain}</td>
                <td className="px-4 py-2 tabular-nums">{d.total.toLocaleString()}</td>
                <td className="px-4 py-2 tabular-nums">{(d.delivered ?? 0).toLocaleString()}</td>
                <td className="px-4 py-2 tabular-nums">{d.delivery_rate ?? "n/a"}</td>
                <td className="px-4 py-2 tabular-nums">{d.bounce_rate ?? "n/a"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-bold">Recent emails</h2>
          <Link href="/emails" className="text-sm font-semibold text-navy underline">View all</Link>
        </div>
        {stats.data.recentEmails.length === 0 ? (
          <EmptyState title="No emails yet" description="Emails you send through the API or console appear here." />
        ) : (
          <Table head={["To", "Subject", "Status", "Sent"]}>
            {stats.data.recentEmails.map((e) => (
              <tr key={e.id} className="hover:bg-offwhite">
                <td className="max-w-48 truncate px-4 py-3">{e.to.join(", ")}</td>
                <td className="max-w-72 truncate px-4 py-3">
                  <Link href={`/emails/${e.id}`} className="font-semibold text-navy hover:underline">{e.subject}</Link>
                </td>
                <td className="px-4 py-3"><StatusBadge status={e.status} /></td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(e.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
