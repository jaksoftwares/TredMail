"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Badge, Button, Card, CopyButton, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Table, formatDate } from "@/components/ui";

interface WebhookRow {
  id: string;
  url: string;
  subscribed_to: string[];
  is_active: boolean;
  total_deliveries: number;
  created_at: string;
}

const EVENTS: { value: string; help: string }[] = [
  { value: "email.sent", help: "Accepted by the mail server" },
  { value: "email.delivered", help: "Confirmed by the recipient's server" },
  { value: "email.failed", help: "Not accepted after all retries" },
  { value: "email.bounced", help: "Rejected by the recipient's server" },
  { value: "email.complained", help: "Marked as spam by the recipient" },
  { value: "email.opened", help: "" },
  { value: "email.clicked", help: "" },
];

export default function WebhooksPage() {
  const { can } = useWorkspace();
  const { data, error, mutate } = useApi<{ data: WebhookRow[] }>(can.manageKeys ? "/v1/webhooks" : null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["email.delivered", "email.bounced", "email.failed"]);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (!can.manageKeys) {
    return (
      <>
        <PageHeader title="Webhooks" />
        <Alert tone="info">Only workspace Owners and Admins can manage webhooks.</Alert>
      </>
    );
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFormError(null);
    try {
      const result = await api<{ url: string; secret: string }>("/v1/webhooks", { method: "POST", body: { url, subscribed_to: events } });
      setOpen(false);
      setUrl("");
      setSecret(result);
      mutate();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function test(w: WebhookRow) {
    setTestResult(null);
    try {
      const result = await api<{ success: boolean; message: string; status_code: number }>(`/v1/webhooks/${w.id}/test`, { method: "POST", body: {} });
      setTestResult({ ok: result.success, message: `${result.message}${result.status_code ? ` (HTTP ${result.status_code})` : ""}` });
      mutate();
    } catch (err) {
      setTestResult({ ok: false, message: errorMessage(err) });
    }
  }

  async function remove(w: WebhookRow) {
    if (!confirm(`Delete the webhook to ${w.url}?`)) return;
    try {
      await api(`/v1/webhooks/${w.id}`, { method: "DELETE" });
      mutate();
    } catch (err) {
      alert(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="TredMail POSTs signed JSON events to your endpoints. Verify each request with the endpoint's signing secret (Standard Webhooks format)."
        actions={<Button onClick={() => setOpen(true)}><Plus className="size-4" />Add endpoint</Button>}
      />

      {secret && (
        <div className="mb-6">
          <Card className="border-orange p-4">
            <p className="font-bold">Signing secret for {secret.url}</p>
            <p className="mb-3 mt-1 text-sm text-muted">Shown once. Store it with your endpoint&apos;s configuration to verify the webhook-signature header.</p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-offwhite px-3 py-2 font-mono text-xs">{secret.secret}</code>
              <CopyButton value={secret.secret} />
            </div>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setSecret(null)}>I have stored it</Button>
          </Card>
        </div>
      )}
      {testResult && <div className="mb-4"><Alert tone={testResult.ok ? "success" : "danger"}>{testResult.message}</Alert></div>}

      <Card>
        {error ? (
          <div className="p-4"><Alert tone="danger">{errorMessage(error)}</Alert></div>
        ) : !data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState title="No endpoints" description="Add an HTTPS endpoint to receive delivery, bounce and engagement events." action={<Button onClick={() => setOpen(true)}>Add endpoint</Button>} />
        ) : (
          <Table head={["Endpoint", "Events", "Deliveries", "Created", ""]}>
            {data.data.map((w) => (
              <tr key={w.id}>
                <td className="max-w-72 break-all px-4 py-3 font-mono text-xs">{w.url}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">{w.subscribed_to.map((e) => <Badge key={e}>{e}</Badge>)}</div>
                </td>
                <td className="px-4 py-3 text-muted">{w.total_deliveries}</td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(w.created_at)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <Button variant="secondary" size="sm" onClick={() => test(w)}>Send test</Button>{" "}
                  <Button variant="danger" size="sm" onClick={() => remove(w)}>Delete</Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} title="Add a webhook endpoint">
        <form onSubmit={onCreate} className="space-y-4">
          {formError && <Alert tone="danger">{formError}</Alert>}
          <Field label="Endpoint URL" hint="Must be HTTPS and reachable from the internet.">
            <Input type="url" required placeholder="https://example.com/webhooks/tredmail" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Events</legend>
            <div className="space-y-2">
              {EVENTS.map((evt) => (
                <label key={evt.value} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-orange"
                    checked={events.includes(evt.value)}
                    onChange={(e) => setEvents(e.target.checked ? [...events, evt.value] : events.filter((v) => v !== evt.value))}
                  />
                  <span>
                    <span className="font-mono text-xs font-semibold">{evt.value}</span>
                    {evt.help && <span className="block text-xs text-muted">{evt.help}</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={loading} disabled={events.length === 0}>Add endpoint</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
