"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { UserPlus } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace, type Role } from "@/lib/workspace";
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Spinner, Table, formatDate } from "@/components/ui";

interface MemberRow {
  id: string;
  role: Role;
  joined_at: string;
  user: { id: string; name: string; email: string; twoFactorEnabled: boolean | null };
}

interface InvitationRow {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
}

const ROLE_HELP: Record<Role, string> = {
  OWNER: "Everything, including billing and removing the workspace",
  ADMIN: "Domains, API keys, webhooks and members",
  DEVELOPER: "Send email, read logs, domains and stats",
  VIEWER: "Read-only access to logs, domains and stats",
};

export default function MembersPage() {
  const router = useRouter();
  const { me, workspace, can, refreshMe } = useWorkspace();
  const members = useApi<{ data: MemberRow[] }>("/v1/members");
  const invitations = useApi<{ data: InvitationRow[] }>("/v1/invitations");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("DEVELOPER");
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const assignable: Role[] = workspace.role === "OWNER" ? ["OWNER", "ADMIN", "DEVELOPER", "VIEWER"] : ["ADMIN", "DEVELOPER", "VIEWER"];

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFormError(null);
    try {
      const result = await api<{ email: string; email_sent: boolean }>("/v1/invitations", { method: "POST", body: { email, role } });
      setOpen(false);
      setEmail("");
      setNotice(
        result.email_sent
          ? { ok: true, message: `Invitation sent to ${result.email}.` }
          : { ok: false, message: `Invitation created, but the email to ${result.email} could not be sent. Revoke it and try again later.` }
      );
      invitations.mutate();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function act(action: () => Promise<unknown>, after?: () => void) {
    setNotice(null);
    try {
      await action();
      members.mutate();
      invitations.mutate();
      after?.();
    } catch (err) {
      setNotice({ ok: false, message: errorMessage(err) });
    }
  }

  if (!members.data) return <Spinner />;

  return (
    <>
      {notice && <div className="mb-4"><Alert tone={notice.ok ? "success" : "danger"}>{notice.message}</Alert></div>}

      <Card className="mb-6">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-bold">Members</h2>
          {can.manageMembers && (
            <Button size="sm" onClick={() => setOpen(true)}><UserPlus className="size-4" />Invite</Button>
          )}
        </div>
        <Table head={["Name", "Role", "Two-step", "Joined", ""]}>
          {members.data.data.map((m) => {
            const isMe = m.user.id === me.user.id;
            const editable = can.manageMembers && !isMe && (workspace.role === "OWNER" || m.role !== "OWNER");
            return (
              <tr key={m.id}>
                <td className="px-4 py-3">
                  <p className="font-semibold">{m.user.name}{isMe && <span className="font-normal text-subtle"> (you)</span>}</p>
                  <p className="text-xs text-muted">{m.user.email}</p>
                </td>
                <td className="px-4 py-3">
                  {editable ? (
                    <Select
                      aria-label={`Role for ${m.user.name}`}
                      value={m.role}
                      onChange={(e) => act(() => api(`/v1/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }))}
                      className="h-8 max-w-36"
                    >
                      {assignable.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
                    </Select>
                  ) : (
                    <Badge>{m.role.toLowerCase()}</Badge>
                  )}
                </td>
                <td className="px-4 py-3">{m.user.twoFactorEnabled ? <Badge tone="success">on</Badge> : <Badge tone="warning">off</Badge>}</td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(m.joined_at)}</td>
                <td className="px-4 py-3 text-right">
                  {isMe ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        confirm(`Leave ${workspace.name}?`) &&
                        act(() => api(`/v1/members/${m.id}`, { method: "DELETE" }), async () => {
                          await refreshMe();
                          router.replace("/overview");
                        })
                      }
                    >
                      Leave
                    </Button>
                  ) : (
                    editable && (
                      <Button variant="danger" size="sm" onClick={() => confirm(`Remove ${m.user.name} from ${workspace.name}?`) && act(() => api(`/v1/members/${m.id}`, { method: "DELETE" }))}>
                        Remove
                      </Button>
                    )
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Card>
        <h2 className="border-b border-line px-4 py-3 font-bold">Pending invitations</h2>
        {!invitations.data ? (
          <Spinner />
        ) : invitations.data.data.length === 0 ? (
          <EmptyState title="No pending invitations" />
        ) : (
          <Table head={["Email", "Role", "Expires", ""]}>
            {invitations.data.data.map((i) => (
              <tr key={i.id}>
                <td className="px-4 py-3 font-semibold">{i.email}</td>
                <td className="px-4 py-3"><Badge>{i.role.toLowerCase()}</Badge></td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(i.expires_at)}</td>
                <td className="px-4 py-3 text-right">
                  {can.manageMembers && (
                    <Button variant="secondary" size="sm" onClick={() => act(() => api(`/v1/invitations/${i.id}`, { method: "DELETE" }))}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} title={`Invite to ${workspace.name}`}>
        <form onSubmit={onInvite} className="space-y-4">
          {formError && <Alert tone="danger">{formError}</Alert>}
          <Field label="Email address">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role" hint={ROLE_HELP[role]}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {assignable.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={loading}>Send invitation</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
