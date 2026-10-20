"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Badge, Button, Card, CopyButton, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Table, formatDate } from "@/components/ui";

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const SCOPE_OPTIONS: { value: string; label: string; help: string }[] = [
  { value: "emails:send", label: "Send emails", help: "The usual choice for an application." },
  { value: "emails:read", label: "Read emails", help: "Look up message status and events." },
  { value: "domains:read", label: "Read domains", help: "" },
  { value: "domains:manage", label: "Manage domains", help: "" },
  { value: "webhooks:manage", label: "Manage webhooks", help: "" },
  { value: "suppressions:manage", label: "Manage suppressions", help: "" },
  { value: "stats:read", label: "Read stats", help: "" },
  { value: "full_access", label: "Full access", help: "Everything, including creating other keys. Use sparingly." },
];

export default function ApiKeysPage() {
  const { can } = useWorkspace();
  const { data, error, mutate } = useApi<{ data: ApiKeyRow[] }>(can.manageKeys ? "/v1/api-keys" : null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["emails:send"]);
  const [expires, setExpires] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  if (!can.manageKeys) {
    return (
      <>
        <PageHeader title="API keys" />
        <Alert tone="info">Only workspace Owners and Admins can see and create API keys.</Alert>
      </>
    );
  }

  function closeCreate() {
    setOpen(false);
    setName("");
    setScopes(["emails:send"]);
    setExpires("");
    setFormError(null);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (scopes.length === 0) {
      setFormError("Choose at least one permission.");
      return;
    }
    setLoading(true);
    setFormError(null);
    try {
      const result = await api<{ name: string; token: string }>("/v1/api-keys", {
        method: "POST",
        body: { name, scopes, expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : undefined },
      });
      closeCreate();
      setCreated(result);
      mutate();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function revoke(key: ApiKeyRow) {
    if (!confirm(`Revoke "${key.name}"? Applications using it will stop working immediately.`)) return;
    try {
      await api(`/v1/api-keys/${key.id}`, { method: "DELETE" });
      mutate();
    } catch (err) {
      alert(errorMessage(err));
    }
  }

  const active = data?.data.filter((k) => !k.revokedAt) ?? [];
  const revoked = data?.data.filter((k) => k.revokedAt) ?? [];

  return (
    <>
      <PageHeader
        title="API keys"
        description="Keys let your applications call the TredMail API. Give each service its own key with only the permissions it needs."
        actions={<Button onClick={() => setOpen(true)}><Plus className="size-4" />Create key</Button>}
      />

      {created && (
        <div className="mb-6">
          <Card className="border-orange p-4">
            <p className="font-bold">Copy your new key now</p>
            <p className="mb-3 mt-1 text-sm text-muted">
              This is the only time &quot;{created.name}&quot; is shown. Store it in your secret manager or environment as <code className="font-mono">TREDMAIL_API_KEY</code>.
            </p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-offwhite px-3 py-2 font-mono text-xs">{created.token}</code>
              <CopyButton value={created.token} />
            </div>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setCreated(null)}>I have stored it</Button>
          </Card>
        </div>
      )}

      <Card>
        {error ? (
          <div className="p-4"><Alert tone="danger">{errorMessage(error)}</Alert></div>
        ) : !data ? (
          <Spinner />
        ) : active.length === 0 ? (
          <EmptyState title="No active keys" description="Create a key to send email from your application." action={<Button onClick={() => setOpen(true)}>Create key</Button>} />
        ) : (
          <Table head={["Name", "Key", "Permissions", "Last used", "Expires", ""]}>
            {active.map((k) => (
              <tr key={k.id}>
                <td className="px-4 py-3 font-semibold">{k.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted">{k.keyPrefix}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">{k.lastUsedAt ? formatDate(k.lastUsedAt) : "Never"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">{k.expiresAt ? formatDate(k.expiresAt) : "Never"}</td>
                <td className="px-4 py-3 text-right">
                  <Button variant="danger" size="sm" onClick={() => revoke(k)}>Revoke</Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {revoked.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-semibold text-muted">Revoked keys ({revoked.length})</summary>
          <ul className="mt-2 space-y-1 text-muted">
            {revoked.map((k) => (
              <li key={k.id}>
                {k.name} <span className="font-mono text-xs">{k.keyPrefix}</span> · revoked {formatDate(k.revokedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}

      <Dialog open={open} onClose={closeCreate} title="Create an API key">
        <form onSubmit={onCreate} className="space-y-4">
          {formError && <Alert tone="danger">{formError}</Alert>}
          <Field label="Name" hint="Where it will be used, for example 'billing-service production'.">
            <Input required maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Permissions</legend>
            <div className="space-y-2">
              {SCOPE_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-orange"
                    checked={scopes.includes(opt.value)}
                    onChange={(e) => setScopes(e.target.checked ? [...scopes, opt.value] : scopes.filter((s) => s !== opt.value))}
                  />
                  <span>
                    <span className="font-semibold">{opt.label}</span>
                    {opt.help && <span className="block text-xs text-muted">{opt.help}</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Expires (optional)" hint="Leave empty for a key that does not expire.">
            <Input type="date" value={expires} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={closeCreate}>Cancel</Button>
            <Button type="submit" loading={loading}>Create key</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
