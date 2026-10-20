"use client";

import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Save, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Button, Card, CopyButton, Dialog, Field, Input, PageHeader, Spinner, Textarea } from "@/components/ui";
import type { TemplateRow } from "@/lib/types";

interface Preview {
  subject: string;
  html: string | null;
  text: string | null;
  missing_variables: string[];
}

const VARIABLE = /\{\{\{?\s*([A-Za-z_][\w.-]*)/g;
const variablesIn = (...sources: string[]) => [...new Set(sources.flatMap((s) => [...s.matchAll(VARIABLE)].map((m) => m[1])))];

function TemplateEditor({ template, justSaved, onSaved }: { template: TemplateRow; justSaved: boolean; onSaved: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(template.name);
  const [alias, setAlias] = useState(template.alias);
  const [subject, setSubject] = useState(template.subject);
  const [html, setHtml] = useState(template.html ?? "");
  const [text, setText] = useState(template.text ?? "");
  const [from, setFrom] = useState(template.from ?? "");
  const [replyTo, setReplyTo] = useState(template.reply_to ?? "");
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [view, setView] = useState<"html" | "text">("html");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(justSaved);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const variables = useMemo(() => variablesIn(subject, html, text), [subject, html, text]);
  const dirty =
    name !== template.name ||
    alias !== template.alias ||
    subject !== template.subject ||
    html !== (template.html ?? "") ||
    text !== (template.text ?? "") ||
    from !== (template.from ?? "") ||
    replyTo !== (template.reply_to ?? "");

  // The preview renders the saved template on the server, so it matches what gets sent.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api<Preview>(`/v1/templates/${template.id}/preview`, { method: "POST", body: { variables: samples } })
        .then((result) => !cancelled && setPreview(result))
        .catch(() => undefined);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [template.id, template.updated_at, samples]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/v1/templates/${template.id}`, {
        method: "PATCH",
        body: { name, alias, subject, html: html || null, text: text || null, from: from || null, reply_to: replyTo || null },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    try {
      await api(`/v1/templates/${template.id}`, { method: "DELETE" });
      router.push("/templates");
    } catch (err) {
      setError(errorMessage(err));
      setDeleteOpen(false);
    }
  }

  const snippet = JSON.stringify(
    { from: from || "you@your-domain.com", to: "customer@example.com", template: alias, variables: Object.fromEntries(variables.map((v) => [v, samples[v] || `<${v}>`])) },
    null,
    2,
  );

  return (
    <>
      <Link href="/templates" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-navy hover:underline">
        <ArrowLeft className="size-4" /> Templates
      </Link>
      <PageHeader
        title={template.name}
        description={<span className="font-mono text-xs">{template.alias}</span>}
        actions={
          <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="size-3.5" />Delete
          </Button>
        }
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <form onSubmit={onSave} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {saved && !dirty && <Alert tone="success">Saved. New sends use this version.</Alert>}
          <Card className="space-y-4 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input required value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Alias">
                <Input required pattern="[a-z0-9][a-z0-9_-]*" value={alias} onChange={(e) => setAlias(e.target.value)} />
              </Field>
              <Field label="Default sender" hint="Optional. Used when a send request has no 'from'.">
                <Input value={from} placeholder="Dovepeak <hello@your-domain.com>" onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="Default reply-to" hint="Optional.">
                <Input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
              </Field>
            </div>
            <Field label="Subject">
              <Input required value={subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field
              label="HTML"
              hint={
                <>
                  <code className="font-mono">{"{{name}}"}</code> is escaped, <code className="font-mono">{"{{{url}}}"}</code> is inserted as-is, and{" "}
                  <code className="font-mono">{"{{plan|Free}}"}</code> sets a default.
                </>
              }
            >
              <Textarea rows={14} value={html} onChange={(e) => setHtml(e.target.value)} className="font-mono text-xs" />
            </Field>
            <Field label="Plain text" hint="Recommended: some mail apps and spam filters prefer a text version.">
              <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={saving} disabled={!dirty}>
                <Save className="size-4" />Save
              </Button>
            </div>
          </Card>
        </form>

        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <h2 className="font-bold text-navy">Sample values</h2>
            {variables.length === 0 ? (
              <p className="text-sm text-muted">This template has no variables.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {variables.map((v) => (
                  <Field key={v} label={v}>
                    <Input value={samples[v] ?? ""} onChange={(e) => setSamples({ ...samples, [v]: e.target.value })} />
                  </Field>
                ))}
              </div>
            )}
            {dirty && <p className="text-xs text-subtle">The preview shows the saved version. Save to preview your changes.</p>}
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-2 border-b border-line p-2">
              <div className="flex gap-1">
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
              {preview && preview.missing_variables.length > 0 && (
                <span className="text-xs font-semibold text-warning">Missing: {preview.missing_variables.join(", ")}</span>
              )}
            </div>
            {!preview ? (
              <Spinner label="Rendering" />
            ) : (
              <>
                <p className="border-b border-line px-4 py-2 text-sm">
                  <span className="font-semibold text-subtle">Subject: </span>
                  {preview.subject}
                </p>
                {view === "html" && preview.html ? (
                  // sandbox with no permissions: no scripts, forms or navigation from template content
                  <iframe title="Template preview" sandbox="" srcDoc={preview.html} className="h-[420px] w-full rounded-b-lg bg-white" />
                ) : (
                  <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs">{preview.text ?? "No plain-text version."}</pre>
                )}
              </>
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <h2 className="text-sm font-bold text-navy">POST /v1/emails</h2>
              <CopyButton value={snippet} />
            </div>
            <pre className="overflow-auto p-4 font-mono text-xs">{snippet}</pre>
          </Card>
        </div>
      </div>

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete this template?">
        <p className="text-sm text-muted">
          Sends that use <span className="font-mono">{template.alias}</span> will fail with <span className="font-mono">template_not_found</span>. Emails already sent keep their content.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleteOpen(false)}>Keep it</Button>
          <Button variant="danger" onClick={onDelete}>Delete template</Button>
        </div>
      </Dialog>
    </>
  );
}

function TemplatePageContent() {
  const { id } = useParams<{ id: string }>();
  const { can } = useWorkspace();
  const { data, error, mutate } = useApi<TemplateRow>(can.manageTemplates ? `/v1/templates/${id}` : null);
  const [justSaved, setJustSaved] = useState(false);
  if (!can.manageTemplates) return <Alert tone="info">Viewers cannot open templates.</Alert>;
  if (error) return <Alert tone="danger">{errorMessage(error)}</Alert>;
  if (!data) return <Spinner />;
  // Keyed by version so the form resets to what the server saved
  return (
    <TemplateEditor
      key={data.updated_at}
      template={data}
      justSaved={justSaved}
      onSaved={() => {
        setJustSaved(true);
        void mutate();
      }}
    />
  );
}

// useParams() reads URL data that only exists at request time, so it must render inside Suspense.
export default function TemplatePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <TemplatePageContent />
    </Suspense>
  );
}
