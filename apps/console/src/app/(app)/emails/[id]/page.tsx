"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { useApi } from "@/lib/workspace";
import { Alert, Card, PageHeader, Spinner, StatusBadge, formatDate } from "@/components/ui";

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
  smtp_response: string | null;
  events: { id: string; type: string; timestamp: string; ip_address: string | null; user_agent: string | null; link_url: string | null; details: Record<string, unknown> | null }[];
}

function eventDetail(e: EmailDetail["events"][number]): string | null {
  if (e.link_url) return e.link_url;
  const d = e.details;
  if (!d) return null;
  if (typeof d.error === "string") return d.error;
  if (typeof d.smtpResponse === "string") return d.smtpResponse;
  if (typeof d.diagnostic_message === "string") return d.diagnostic_message;
  return null;
}

function EmailDetailPageContent() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<EmailDetail>(`/v1/emails/${id}`, { refreshInterval: 5000 });
  const [view, setView] = useState<"html" | "text">("html");

  if (error) return <Alert tone="danger">{errorMessage(error)}</Alert>;
  if (!data) return <Spinner />;

  const rows: [string, string][] = [
    ["From", data.from],
    ["To", data.to.join(", ")],
    ...(data.cc.length ? ([["Cc", data.cc.join(", ")]] as [string, string][]) : []),
    ...(data.bcc.length ? ([["Bcc", data.bcc.join(", ")]] as [string, string][]) : []),
    ...(data.reply_to ? ([["Reply-to", data.reply_to]] as [string, string][]) : []),
    ["Created", formatDate(data.created_at)],
    ["ID", data.id],
  ];
  const showHtml = view === "html" && data.html;

  return (
    <>
      <Link href="/emails" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-navy hover:underline">
        <ArrowLeft className="size-4" /> Emails
      </Link>
      <PageHeader title={data.subject} actions={<StatusBadge status={data.status} />} />

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
