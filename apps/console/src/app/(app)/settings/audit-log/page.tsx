"use client";

import { errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { Alert, Badge, Card, EmptyState, Spinner, Table, formatDate } from "@/components/ui";

interface AuditEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

function describe(metadata: Record<string, unknown> | null): string {
  if (!metadata) return "";
  return Object.entries(metadata)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(" · ");
}

export default function AuditLogPage() {
  const { can } = useWorkspace();
  const { data, error } = useApi<{ data: AuditEntry[] }>(can.manageMembers ? "/v1/audit-logs?limit=200" : null);

  if (!can.manageMembers) return <Alert tone="info">Only Owners and Admins can view the audit log.</Alert>;
  if (error) return <Alert tone="danger">{errorMessage(error)}</Alert>;
  if (!data) return <Spinner />;

  return (
    <Card>
      {data.data.length === 0 ? (
        <EmptyState title="No changes recorded yet" />
      ) : (
        <Table head={["When", "Action", "By", "Details", "IP"]}>
          {data.data.map((e) => (
            <tr key={e.id}>
              <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(e.createdAt)}</td>
              <td className="px-4 py-3 font-mono text-xs font-semibold">{e.action}</td>
              <td className="px-4 py-3"><Badge>{e.actorType.replace("_", " ")}</Badge></td>
              <td className="max-w-96 truncate px-4 py-3 text-xs text-muted" title={describe(e.metadata)}>{describe(e.metadata)}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted">{e.ipAddress ?? "—"}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
