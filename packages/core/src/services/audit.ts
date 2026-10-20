import { prisma, type Prisma } from "@tredmail/db";

export interface AuditEntry {
  organizationId: string;
  actorType: "user" | "api_key" | "system";
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonObject;
  ipAddress?: string;
}

/** Records an audit entry. Never throws: auditing must not break the action it records. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({ data: entry });
  } catch (err) {
    console.error("[audit] failed to record", entry.action, err);
  }
}
