import { prisma } from "@tredmail/db";
import { env } from "../config/env.js";
import { sendingPausedTemplate } from "../mail/billing-templates.js";
import { operationsAlertTemplate } from "../mail/templates.js";
import { billingRecipients } from "../billing/subscriptions.js";
import { recordAudit } from "./audit.js";
import { sendSystemEmail } from "./system-mailer.js";

/**
 * Pauses a customer workspace whose mail is hurting shared reputation: more than 4% hard
 * bounces, or more than 0.08% spam complaints (well under Gmail's 0.3% ceiling), over the
 * last 24 hours. Dovepeak's own (non-commercial) workspaces are never paused automatically.
 * Staff resume sending in the back-office once the cause is fixed.
 */

export const HARD_BOUNCE_LIMIT = 0.04;
export const COMPLAINT_LIMIT = 0.0008;
const MIN_ATTEMPTS_FOR_BOUNCES = 50;
const MIN_DELIVERED_FOR_COMPLAINTS = 500;
const MIN_COMPLAINTS = 3;

export interface WorkspaceMailStats {
  delivered: number;
  hardBounced: number;
  complained: number;
}

export function breakerDecision(stats: WorkspaceMailStats): string | null {
  const attempted = stats.delivered + stats.hardBounced;
  if (attempted >= MIN_ATTEMPTS_FOR_BOUNCES && stats.hardBounced / attempted > HARD_BOUNCE_LIMIT) {
    return `${((stats.hardBounced / attempted) * 100).toFixed(1)}% of messages hard-bounced in the last 24 hours (limit ${HARD_BOUNCE_LIMIT * 100}%)`;
  }
  if (stats.delivered >= MIN_DELIVERED_FOR_COMPLAINTS && stats.complained >= MIN_COMPLAINTS && stats.complained / stats.delivered > COMPLAINT_LIMIT) {
    return `${((stats.complained / stats.delivered) * 100).toFixed(2)}% of delivered messages were reported as spam in the last 24 hours (limit ${(COMPLAINT_LIMIT * 100).toFixed(2)}%)`;
  }
  return null;
}

export async function checkCircuitBreakers(now = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const rows = await prisma.$queryRaw<Array<{ organizationId: string; name: string; delivered: bigint; hard: bigint; complained: bigint }>>`
    SELECT e."organizationId", o."name",
      count(*) FILTER (WHERE ev."type" = 'DELIVERED') AS delivered,
      count(*) FILTER (WHERE ev."type" = 'BOUNCED' AND ev."bounceType" = 'HARD') AS hard,
      count(*) FILTER (WHERE ev."type" = 'COMPLAINED') AS complained
    FROM "email_events" ev
    JOIN "emails" e ON e."id" = ev."emailId"
    JOIN "organizations" o ON o."id" = e."organizationId"
    WHERE ev."timestamp" >= ${since} AND o."isCommercial" = true AND o."sendingPausedAt" IS NULL
      AND ev."type" IN ('DELIVERED', 'BOUNCED', 'COMPLAINED')
    GROUP BY e."organizationId", o."name"`;

  const paused: string[] = [];
  for (const row of rows) {
    const reason = breakerDecision({ delivered: Number(row.delivered), hardBounced: Number(row.hard), complained: Number(row.complained) });
    if (!reason) continue;
    const updated = await prisma.organization.updateMany({
      where: { id: row.organizationId, sendingPausedAt: null },
      data: { sendingPausedAt: now, sendingPauseReason: reason },
    });
    if (updated.count === 0) continue;
    paused.push(row.organizationId);
    await recordAudit({ organizationId: row.organizationId, actorType: "system", action: "workspace.sending_paused", metadata: { reason } });
    const url = `${env.CONSOLE_URL.replace(/\/+$/, "")}/emails?status=bounced,complained&workspace=${row.organizationId}`;
    for (const to of await billingRecipients(row.organizationId)) {
      await sendSystemEmail(to, sendingPausedTemplate({ workspace: row.name, reason, url })).catch((err) => console.error("[breaker] owner email failed", err));
    }
    if (env.OPS_EMAIL) {
      await sendSystemEmail(
        env.OPS_EMAIL,
        operationsAlertTemplate({
          title: `Sending paused for ${row.name}`,
          summary: reason,
          details: [`Workspace ${row.organizationId}. Review its recent mail and resume it in the back-office when the cause is fixed.`],
        }),
      ).catch((err) => console.error("[breaker] ops email failed", err));
    }
  }
  return paused;
}
