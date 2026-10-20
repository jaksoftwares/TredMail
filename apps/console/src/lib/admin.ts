/** Shapes and helpers for the staff back-office. */
import type { BillingAccount, Entitlements, InvoiceSummary, Payment, Plan, Subscription, Usage } from "./billing";

export interface AdminOverview {
  workspaces: number;
  paying_workspaces: number;
  by_plan: Record<string, number>;
  mrr: Record<string, number>;
  collected_this_month: Record<string, number>;
  payments_this_month: number;
  outstanding: Record<string, number>;
  overdue: Record<string, number>;
  past_due_workspaces: number;
  unmatched_payments: number;
  paused_workspaces: number;
  suspended_workspaces: number;
}

export interface AdminWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  owner_email: string | null;
  plan: string;
  plan_name: string;
  interval: string;
  billing_status: string;
  account_code: string | null;
  emails_30d: number;
  suspended: boolean;
  sending_paused: boolean;
  is_commercial: boolean;
  created_at: string;
}

export interface AdminWorkspace {
  workspace: {
    id: string;
    name: string;
    slug: string;
    website: string | null;
    use_case: string | null;
    is_commercial: boolean;
    created_at: string;
    suspended_at: string | null;
    suspended_reason: string | null;
    sending_paused_at: string | null;
    sending_pause_reason: string | null;
  };
  members: Array<{ email: string; name: string; role: string }>;
  domains: Array<{ name: string; status: string }>;
  subscription: Subscription;
  entitlements: Entitlements;
  usage: Usage;
  account: BillingAccount;
  invoices: InvoiceSummary[];
  payments: Payment[];
  audit: Array<{ action: string; actor_type: string; metadata: unknown; created_at: string }>;
}

export interface AdminPlan extends Plan {
  is_public: boolean;
  is_active: boolean;
  sort_order: number;
  workspaces: number;
}

/** Sums per currency, e.g. "KES 12,500 · USD 40". */
export function moneyByCurrency(values: Record<string, number>, format: (amount: number, currency: string) => string): string {
  const entries = Object.entries(values).filter(([, v]) => v !== 0);
  return entries.length ? entries.map(([c, v]) => format(v, c)).join(" · ") : format(0, "KES");
}

/** "2,500" or "2500.50" typed by staff -> minor units; null when empty. */
export function toMinor(value: string): number | null {
  const cleaned = value.replace(/[,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export const toMajor = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value / 100));
