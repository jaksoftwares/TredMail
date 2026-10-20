"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Ban, SendHorizontal } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Button, Card, PageHeader, Spinner, StatusBadge, formatDate } from "@/components/ui";

interface EmailDetail {
  id: string;
  domain: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  status: string;
  created_at: string;
  scheduled_at: string | null;
  template: { id: string; alias: string } | null;
  attachments: { filename: string; content_type: string | null; size: number }[];
  smtp_response: string | null;
  events: { id: string; type: string; timestamp: string; ip_address: string | null; user_agent: string | null; link_url: string | null; details: Record<string, unknown> | null }[];
}

function eventDetail(e: EmailDetail["events"][number]): string | null {
  if (e.link_url) return e.link_url;
  const d = e.details;
  if (!d) return null;
  const text = (key: string) => (typeof d[key] === "string" && d[key] ? (d[key] as string) : null);
  if (d.reason === "warmup_cap_reached") return "Held until tomorrow: today's IP warm-up limit was reached";
  if (typeof d.scheduledAt === "string") return `${d.rescheduled ? "Rescheduled" : "Scheduled"} for ${formatDate(d.scheduledAt)}`;
  const parts = [
    text("recipient"),
    text("category") && `category: ${text("category")}`,
    d.suppressed === true ? "recipient suppressed" : null,
    text("diagnostic") ?? text("response") ?? text("error") ?? text("smtpResponse") ?? text("diagnostic_message"),
    text("route") === "fallback" ? "sent through the fallback provider" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function EmailDetailPageContent() {
  const { id } = useParams<{ id: string }>();
  const { data, error, mutate } = useApi<EmailDetail>(`/v1/emails/${id}`, { refreshInterval: 5000 });
  const { can } = useWorkspace();
  const [view, setView] = useState<"html" | "text">("html");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(path: string, method: string, body?: unknown) {
    setBusy(true);
    setActionError(null);
    try {
      await api(path, { method, body });
      await mutate();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert tone="danger">{errorMessage(error)}</Alert>;
  if (!data) return <Spinner />;

  const rows: [string, string][] = [
    ["From", data.from],
    ["To", data.to.join(", ")],
    ...(data.cc.length ? ([["Cc", data.cc.join(", ")]] as [string, string][]) : []),
    ...(data.bcc.length ? ([["Bcc", data.bcc.join(", ")]] as [string, string][]) : []),
    ...(data.reply_to ? ([["Reply-to", data.reply_to]] as [string, string][]) : []),
    ...(data.scheduled_at ? ([["Send at", formatDate(data.scheduled_at)]] as [string, string][]) : []),
    ...(data.template ? ([["Template", data.template.alias]] as [string, string][]) : []),
    ...(data.attachments.length
      ? ([["Attachments", data.attachments.map((a) => `${a.filename} (${Math.max(1, Math.round(a.size / 1024))} KB)`).join(", ")]] as [string, string][])
      : []),
    ["Created", formatDate(data.created_at)],
    ["ID", data.id],
  ];
  const scheduled = data.status === "scheduled";
  const showHtml = view === "html" && data.html;

  return (
    <>
      <Link href="/emails" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-navy hover:underline">
        <ArrowLeft className="size-4" /> Emails
      </Link>
      <PageHeader
        title={data.subject}
        actions={
          <div className="flex items-center gap-2">
            {scheduled && can.send && (
              <>
                <Button variant="secondary" size="sm" loading={busy} onClick={() => act(`/v1/emails/${data.id}`, "PATCH", { scheduled_at: new Date().toISOString() })}>
                  <SendHorizontal className="size-3.5" />Send now
                </Button>
                <Button variant="danger" size="sm" loading={busy} onClick={() => act(`/v1/emails/${data.id}/cancel`, "POST")}>
                  <Ban className="size-3.5" />Cancel
                </Button>
              </>
            )}
            <StatusBadge status={data.status} />
          </div>
        }
      />
      {actionError && <div className="mb-4"><Alert tone="danger">{actionError}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <dl className="divide-y divide-line text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[96px_1fr] gap-3 px-4 py-2.5">
                  <dt className="font-semibold text-subtle">{k}</dt>
                  <dd className="break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <div className="flex gap-1 border-b border-line p-2">
              {(["html", "text"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded px-3 py-1.5 text-sm font-semibold ${view === v ? "bg-navy text-offwhite" : "text-navy hover:bg-navy/5"}`}
                >
                  {v.toUpperCase()}
                </button>
              ))}
            </div>
            {showHtml ? (
              // sandbox with no permissions: no scripts, forms, or navigation from email content
              <iframe title="Email preview" sandbox="" srcDoc={data.html!} className="h-[480px] w-full rounded-b-lg bg-white" />
            ) : (
              <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs">{data.text ?? "No plain-text version."}</pre>
            )}
          </Card>
        </div>

        <Card className="h-fit">
          <h2 className="border-b border-line px-4 py-3 font-bold">Timeline</h2>
          <ol className="space-y-4 p-4">
            {data.events.map((e) => {
              const detail = eventDetail(e);
              return (
                <li key={e.id} className="relative pl-5">
                  <span className="absolute left-0 top-1.5 size-2 rounded-full bg-orange" aria-hidden />
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status={e.type} />
                    <span className="text-xs text-subtle">{formatDate(e.timestamp)}</span>
                  </div>
                  {detail && <p className="mt-1 break-all text-xs text-muted">{detail}</p>}
                </li>
              );
            })}
          </ol>
          {data.smtp_response && (
            <p className="border-t border-line px-4 py-3 text-xs text-muted">
              <span className="font-semibold text-navy">Server response: </span>
              {data.smtp_response}
            </p>
          )}
        </Card>
      </div>
    </>
  );
}

// useParams() reads URL data that only exists at request time, so it must render inside Suspense.
export default function EmailDetailPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <EmailDetailPageContent />
    </Suspense>
  );
}
