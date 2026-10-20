"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import type { DomainRow } from "@/lib/types";
import { Alert, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Spinner, StatusBadge, Table, formatDate } from "@/components/ui";

export default function DomainsPage() {
  const router = useRouter();
  const { can, me } = useWorkspace();
  const { data, error } = useApi<{ data: DomainRow[] }>("/v1/domains");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFormError(null);
    try {
      const created = await api<{ id: string }>("/v1/domains", { method: "POST", body: { name: name.trim().toLowerCase() } });
      router.push(`/domains/${created.id}`);
    } catch (err) {
      setFormError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Domains"
        description="Send from your own domain. TredMail signs every message with the domain's DKIM key once its DNS records are verified."
        actions={can.manageDomains && <Button onClick={() => setOpen(true)}><Plus className="size-4" />Add domain</Button>}
      />
      <Card>
        {error ? (
          <div className="p-4"><Alert tone="danger">{errorMessage(error)}</Alert></div>
        ) : !data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState
            title="No domains yet"
            description={`Until you add one, you can send from ${me.sandbox_sender} to your workspace members.`}
            action={can.manageDomains && <Button onClick={() => setOpen(true)}>Add your first domain</Button>}
          />
        ) : (
          <Table head={["Domain", "Status", "Added"]}>
            {data.data.map((d) => (
              <tr key={d.id} className="hover:bg-offwhite">
                <td className="px-4 py-3">
                  <Link href={`/domains/${d.id}`} className="font-semibold text-navy hover:underline">{d.name}</Link>
                </td>
                <td className="px-4 py-3"><StatusBadge status={d.status} /></td>
                <td className="px-4 py-3 text-muted">{formatDate(d.created_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} title="Add a domain">
        <form onSubmit={onSubmit} className="space-y-4">
          {formError && <Alert tone="danger">{formError}</Alert>}
          <Field label="Domain" hint="The part after @ in your sender address, for example acme.com or mail.acme.com.">
            <Input required placeholder="acme.com" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={loading}>Add domain</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
