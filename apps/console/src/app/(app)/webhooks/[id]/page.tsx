"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, KeyRound, Pause, Play, RotateCcw, Send } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Badge, Button, Card, CopyButton, EmptyState, PageHeader, Select, Spinner, StatusBadge, formatDate } from "@/components/ui";

interface WebhookRow {
  id: string;
  url: string;
  subscribed_to: string[];
  is_active: boolean;
  total_deliveries: number;
  failed_deliveries_7d: number;
  created_at: string;
}

interface Delivery {
  id: string;
  event: string;
  message_id: string | null;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  status_code: number | null;
  response: string | null;
  payload: unknown;
  created_at: string;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
}

function DeliveryRow({ delivery, onReplay, canReplay }: { delivery: Delivery; onReplay: () => void; canReplay: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line last:border-0">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-offwhite" aria-expanded={open}>
        <StatusBadge status={delivery.status} />
        <span className="font-mono text-xs font-semibold text-navy">{delivery.event}</span>
        <span className="hidden text-xs text-muted sm:inline">
          {delivery.attempts} attempt{delivery.attempts === 1 ? "" : "s"}
          {delivery.status_code ? ` · HTTP ${delivery.status_code}` : ""}
        </span>
        <span className="ml-auto whitespace-nowrap text-xs text-subtle">{formatDate(delivery.created_at)}</span>
      </button>
      {open && (
        <div className="space-y-3 bg-offwhite px-4 pb-4 pt-1 text-xs">
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1">
            <dt className="font-semibold text-subtle">webhook-id</dt>
            <dd className="break-all font-mono">{delivery.message_id ?? delivery.id}</dd>
            <dt className="font-semibold text-subtle">Last attempt</dt>
            <dd>{delivery.last_attempt_at ? formatDate(delivery.last_attempt_at) : "not yet"}</dd>
            {delivery.status === "pending" && delivery.next_attempt_at && (
              <>
                <dt className="font-semibold text-subtle">Next attempt</dt>
                <dd>{formatDate(delivery.next_attempt_at)}</dd>
              </>
            )}
            <dt className="font-semibold text-subtle">Your response</dt>
            <dd className="break-all font-mono">{delivery.response || "(empty)"}</dd>
          </dl>
          <pre className="max-h-64 overflow-auto rounded-md border border-line bg-surface p-3 font-mono">{JSON.stringify(delivery.payload, null, 2)}</pre>
          {canReplay && delivery.status !== "pending" && (
            <Button variant="secondary" size="sm" onClick={onReplay}>
              <RotateCcw className="size-3.5" />Replay
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function WebhookPageContent() {
  const { id } = useParams<{ id: string }>();
  const { can } = useWorkspace();
  const [status, setStatus] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: list, mutate: mutateList } = useApi<{ data: WebhookRow[] }>(can.manageWebhooks ? "/v1/webhooks" : null);
  const webhook = list?.data.find((w) => w.id === id);
  const params = new URLSearchParams({ limit: "25" });
  if (status) params.set("status", status);
  if (cursors.at(-1)) params.set("cursor", cursors.at(-1)!);
  const { data, error, mutate } = useApi<{ data: Delivery[]; next_cursor: string | null }>(
    can.manageWebhooks ? `/v1/webhooks/${id}/deliveries?${params}` : null,
    { refreshInterval: 10_000 },
  );

  if (!can.manageWebhooks) return <Alert tone="info">Only workspace Owners and Admins can manage webhooks.</Alert>;
  if (list && !webhook) return <Alert tone="danger">Webhook endpoint not found.</Alert>;
  if (!webhook) return <Spinner />;

  async function run(label: string, action: () => Promise<string | void>) {
    setBusy(true);
    setNotice(null);
    try {
      const message = await action();
      setNotice({ tone: "success", text: message || label });
      await Promise.all([mutate(), mutateList()]);
    } catch (err) {
      setNotice({ tone: "danger", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const w = webhook;
  return (
    <>
      <Link href="/webhooks" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-navy hover:underline">
        <ArrowLeft className="size-4" /> Webhooks
      </Link>
      <PageHeader
        title="Webhook endpoint"
        description={<span className="break-all font-mono text-xs">{w.url}</span>}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() =>
                run("Test sent", async () => {
                  const r = await api<{ success: boolean; message: string; status_code: number }>(`/v1/webhooks/${w.id}/test`, { method: "POST", body: {} });
                  if (!r.success) throw new Error(`${r.message}${r.status_code ? ` (HTTP ${r.status_code})` : ""}`);
                  return r.message;
                })
              }
            >
              <Send className="size-3.5" />Send test
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() =>
                run(w.is_active ? "Paused: events are no longer sent to this endpoint." : "Resumed.", async () => {
                  await api(`/v1/webhooks/${w.id}`, { method: "PATCH", body: { is_active: !w.is_active } });
                })
              }
            >
              {w.is_active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              {w.is_active ? "Pause" : "Resume"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() => {
                if (!confirm("Issue a new signing secret? Requests are signed with it immediately, so update your endpoint right away.")) return;
                void run("New signing secret issued.", async () => {
                  const r = await api<{ secret: string }>(`/v1/webhooks/${w.id}/rotate-secret`, { method: "POST", body: {} });
                  setSecret(r.secret);
                });
              }}
            >
              <KeyRound className="size-3.5" />Rotate secret
            </Button>
          </div>
        }
      />

      {secret && (
        <div className="mb-4">
          <Card className="border-orange p-4">
            <p className="font-bold">New signing secret</p>
            <p className="mb-3 mt-1 text-sm text-muted">Shown once. Replace the old secret in your endpoint&apos;s configuration now.</p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-offwhite px-3 py-2 font-mono text-xs">{secret}</code>
              <CopyButton value={secret} />
            </div>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setSecret(null)}>I have stored it</Button>
          </Card>
        </div>
      )}
      {notice && <div className="mb-4"><Alert tone={notice.tone}>{notice.text}</Alert></div>}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Status</p>
          <p className="mt-1">{w.is_active ? <Badge tone="success">active</Badge> : <Badge tone="warning">paused</Badge>}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Deliveries</p>
          <p className="mt-1 text-2xl font-bold text-navy">{w.total_deliveries}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Failed, last 7 days</p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className={`text-2xl font-bold ${w.failed_deliveries_7d ? "text-danger" : "text-navy"}`}>{w.failed_deliveries_7d}</p>
            {w.failed_deliveries_7d > 0 && w.is_active && (
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                onClick={() =>
                  run("", async () => {
                    const r = await api<{ replayed: number }>(`/v1/webhooks/${w.id}/replay-failed`, { method: "POST", body: {} });
                    return `${r.replayed} deliver${r.replayed === 1 ? "y" : "ies"} queued again.`;
                  })
                }
              >
                <RotateCcw className="size-3.5" />Replay all
              </Button>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-line p-4">
          <div>
            <h2 className="font-bold text-navy">Deliveries</h2>
            <p className="text-xs text-muted">Failed requests are retried for about 27 hours with the same webhook-id.</p>
          </div>
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursors([]);
            }}
            className="max-w-40"
            aria-label="Delivery status"
          >
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
          </Select>
        </div>
        {error ? (
          <div className="p-4"><Alert tone="danger">{errorMessage(error)}</Alert></div>
        ) : !data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState title="No deliveries" description="Events subscribed to by this endpoint will appear here." />
        ) : (
          <>
            <ul>
              {data.data.map((d) => (
                <DeliveryRow
                  key={d.id}
                  delivery={d}
                  canReplay={w.is_active}
                  onReplay={() =>
                    run("Replay queued.", async () => {
                      await api(`/v1/webhooks/${w.id}/deliveries/${d.id}/replay`, { method: "POST", body: {} });
                    })
                  }
                />
              ))}
            </ul>
            <div className="flex justify-between border-t border-line p-3">
              <Button variant="secondary" size="sm" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>Newer</Button>
              <Button variant="secondary" size="sm" disabled={!data.next_cursor} onClick={() => data.next_cursor && setCursors([...cursors, data.next_cursor])}>
                Older
              </Button>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

// useParams() reads URL data that only exists at request time, so it must render inside Suspense.
export default function WebhookPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <WebhookPageContent />
    </Suspense>
  );
}
