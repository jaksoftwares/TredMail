"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, Textarea, formatDate } from "@/components/ui";

interface EmailRow {
  id: string;
  from: string;
  to: string[];
  subject: string;
  status: string;
  created_at: string;
}

const STATUSES = ["queued", "sending", "sent", "delivered", "failed", "bounced", "complained"];

function SendEmailDialog({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: (id: string) => void }) {
  const { me } = useWorkspace();
  const [from, setFrom] = useState(me.sandbox_sender);
  const [to, setTo] = useState(me.user.email);
  const [subject, setSubject] = useState("Hello from TredMail");
  const [body, setBody] = useState("This message was sent from the TredMail console.");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await api<{ id: string }>("/v1/emails", {
        method: "POST",
        body: {
          from,
          to: to.split(",").map((s) => s.trim()).filter(Boolean),
          subject,
          text: body,
          html: `<p>${body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!).replace(/\n/g, "<br>")}</p>`,
        },
      });
      onSent(result.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Send an email">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="From" hint={`Use an address on a verified domain, or ${me.sandbox_sender} to email workspace members.`}>
          <Input required value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" hint="Separate several addresses with commas.">
          <Input required value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Subject">
          <Input required value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message">
          <Textarea required rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}><Send className="size-3.5" />Send</Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function EmailsPage() {
  const { can } = useWorkspace();
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [sendOpen, setSendOpen] = useState(false);

  const params = new URLSearchParams({ limit: "25" });
  if (status) params.set("status", status);
  if (search) params.set("q", search);
  const cursor = cursors.at(-1);
  if (cursor) params.set("cursor", cursor);

  const { data, error, mutate } = useApi<{ data: EmailRow[]; next_cursor: string | null }>(`/v1/emails?${params}`);

  const resetPaging = () => setCursors([]);

  return (
    <>
      <PageHeader
        title="Emails"
        description="Every message sent from this workspace, newest first."
        actions={can.send && <Button onClick={() => setSendOpen(true)}><Send className="size-4" />Send email</Button>}
      />

      <Card>
        <form
          className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query);
            resetPaging();
          }}
        >
          <Input placeholder="Search subject, sender or exact recipient" value={query} onChange={(e) => setQuery(e.target.value)} className="sm:max-w-sm" />
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              resetPaging();
            }}
            className="sm:max-w-44"
            aria-label="Status"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">Search</Button>
        </form>

        {error ? (
          <div className="p-4"><Alert tone="danger">{errorMessage(error)}</Alert></div>
        ) : !data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState title="No emails found" description={search || status ? "Try a different search or status." : "Send an email through the API or with the button above."} />
        ) : (
          <>
            <Table head={["To", "Subject", "From", "Status", "Created"]}>
              {data.data.map((e) => (
                <tr key={e.id} className="hover:bg-offwhite">
                  <td className="max-w-48 truncate px-4 py-3">{e.to.join(", ")}</td>
                  <td className="max-w-72 truncate px-4 py-3">
                    <Link href={`/emails/${e.id}`} className="font-semibold text-navy hover:underline">{e.subject}</Link>
                  </td>
                  <td className="max-w-48 truncate px-4 py-3 text-muted">{e.from}</td>
                  <td className="px-4 py-3"><StatusBadge status={e.status} /></td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(e.created_at)}</td>
                </tr>
              ))}
            </Table>
            <div className="flex justify-between border-t border-line p-3">
              <Button variant="secondary" size="sm" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
                Newer
              </Button>
              <Button variant="secondary" size="sm" disabled={!data.next_cursor} onClick={() => data.next_cursor && setCursors([...cursors, data.next_cursor])}>
                Older
              </Button>
            </div>
          </>
        )}
      </Card>

      <SendEmailDialog
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        onSent={() => {
          setSendOpen(false);
          resetPaging();
          mutate();
        }}
      />
    </>
  );
}
