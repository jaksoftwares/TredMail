"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Table, formatDate } from "@/components/ui";
import type { TemplateRow } from "@/lib/types";


const STARTER_HTML = `<p>Hi {{name}},</p>
<p>Thanks for joining {{product|Dovepeak}}.</p>
<p><a href="{{{action_url}}}">Get started</a></p>`;

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

function CreateTemplateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasEdited, setAliasEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const created = await api<TemplateRow>("/v1/templates", {
        method: "POST",
        body: { name, alias, subject: `Welcome to {{product|Dovepeak}}`, html: STARTER_HTML },
      });
      router.push(`/templates/${created.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New template">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name">
          <Input
            required
            autoFocus
            value={name}
            placeholder="Password reset"
            onChange={(e) => {
              setName(e.target.value);
              if (!aliasEdited) setAlias(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label="Alias" hint="Used in code: { template: &quot;password-reset&quot; }. Lowercase letters, digits, - and _.">
          <Input
            required
            pattern="[a-z0-9][a-z0-9_-]*"
            value={alias}
            onChange={(e) => {
              setAlias(e.target.value);
              setAliasEdited(true);
            }}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create and edit</Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function TemplatesPage() {
  const { can } = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const { data, error } = useApi<{ data: TemplateRow[] }>(can.manageTemplates ? "/v1/templates" : null);

  if (!can.manageTemplates) {
    return (
      <>
        <PageHeader title="Templates" />
        <Alert tone="info">Viewers cannot open templates. Ask a workspace Owner or Admin for Developer access.</Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Templates"
        description={
          <>
            Reusable emails with <code className="font-mono text-xs">{"{{variables}}"}</code>. Send one with{" "}
            <code className="font-mono text-xs">{'{ "template": "alias", "variables": { ... } }'}</code>.
          </>
        }
        actions={<Button onClick={() => setCreateOpen(true)}><Plus className="size-4" />New template</Button>}
      />
      <Card>
        {error ? (
          <div className="p-4"><Alert tone="danger">{errorMessage(error)}</Alert></div>
        ) : !data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState
            title="No templates yet"
            description="Keep subjects and bodies in TredMail and send them by alias, so copy changes never need a deploy."
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="size-4" />New template</Button>}
          />
        ) : (
          <Table head={["Name", "Alias", "Subject", "Variables", "Updated"]}>
            {data.data.map((t) => (
              <tr key={t.id} className="hover:bg-offwhite">
                <td className="px-4 py-3">
                  <Link href={`/templates/${t.id}`} className="font-semibold text-navy hover:underline">{t.name}</Link>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{t.alias}</td>
                <td className="max-w-72 truncate px-4 py-3 text-muted">{t.subject}</td>
                <td className="max-w-56 truncate px-4 py-3 font-mono text-xs text-muted">{t.variables.join(", ") || "none"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(t.updated_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <CreateTemplateDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
