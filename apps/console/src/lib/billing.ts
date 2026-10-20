/** Billing API shapes and formatting. Amounts are integers in minor units (cents). */

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  currency: string;
  price_monthly: number;
  price_yearly: number | null;
  monthly_emails: number;
  daily_emails: number;
  overage_price_per_1000: number | null;
  overage_limit: number | null;
  max_domains: number;
  max_members: number;
  log_retention_days: number;
  features: string[];
}

export interface Usage {
  period_start: string;
  period_end: string;
  emails_sent: number;
  emails_today: number;
  monthly_limit: number;
  daily_limit: number;
  remaining: number | null;
  overage_emails: number;
}

export interface Entitlements {
  plan: string;
  plan_name: string;
  currency: string;
  interval: "month" | "year";
  price: number;
  monthly_emails: number;
  daily_emails: number;
  overage_price_per_1000: number | null;
  overage_limit: number | null;
  max_domains: number;
  max_members: number;
  log_retention_days: number;
}

export interface Subscription {
  plan: Plan;
  interval: "month" | "year";
  status: "active" | "past_due";
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  pending_change: { plan: string; plan_name: string; interval: string; effective_at: string } | null;
  past_due_since: string | null;
  custom: { price: number | null; monthly_emails: number | null; daily_emails: number | null; max_domains: number | null; max_members: number | null };
}

export interface BillingAccount {
  account_code: string;
  billing_email: string | null;
  company_name: string | null;
  tax_id: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  country: string;
  phone: string | null;
  phone_display: string | null;
  auto_collect: boolean;
  credit_balance: number;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  status: "open" | "paid" | "void";
  purpose: "plan_change" | "renewal" | "overage" | "manual";
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  amount_paid: number;
  amount_due: number;
  period_start: string | null;
  period_end: string | null;
  due_at: string;
  paid_at: string | null;
  voided_at: string | null;
  created_at: string;
}

export interface GatewayChoice {
  id: string;
  name: string;
  fields: Array<{ name: string; label: string; placeholder: string | null; hint: string | null; type: "tel" | "text" | "email" }>;
}

export interface Payment {
  id: string;
  invoice_id: string | null;
  invoice_number: string | null;
  organization_id?: string | null;
  gateway: string;
  gateway_name: string;
  method: string;
  method_label: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  amount: number;
  currency: string;
  receipt: string | null;
  account_reference: string | null;
  payer_phone: string | null;
  payer_name: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  completed_at: string | null;
  refunded_at: string | null;
}

export interface OfflineInstructions {
  gateway: string;
  title: string;
  steps: string[];
  fields: Array<{ label: string; value: string }>;
}

export interface Invoice extends InvoiceSummary {
  tax_rate: number;
  notes: string | null;
  billing_details: {
    customer: { workspace: string; name: string; email: string | null; taxId: string | null; address: string[]; accountCode: string };
    seller: { name: string; address: string; website: string; taxId: string | null; email: string | null };
    taxLabel: string;
  };
  lines: Array<{ kind: string; description: string; quantity: number; unit_amount: number; amount: number; period_start: string | null; period_end: string | null }>;
  payments: Payment[];
  pay_with: GatewayChoice[];
  pay_offline: OfflineInstructions | null;
}

export interface BillingOverview {
  subscription: Subscription;
  entitlements: Entitlements;
  usage: Usage;
  account: BillingAccount;
  open_invoices: InvoiceSummary[];
  plans: Plan[];
  gateways: GatewayChoice[];
  standing: { suspended: boolean; suspended_reason: string | null; sending_paused: boolean; sending_pause_reason: string | null };
  can_manage: boolean;
}

/** "KES 2,500" or "USD 19.99". */
export function money(amount: number, currency = "KES"): string {
  const major = amount / 100;
  const whole = Number.isInteger(major);
  return `${currency} ${major.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export const count = (n: number) => n.toLocaleString("en-US");
export const limitLabel = (n: number, unit: string) => (n === 0 ? `Unlimited ${unit}` : `${count(n)} ${unit}`);

export function day(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export const PURPOSE_LABEL: Record<InvoiceSummary["purpose"], string> = {
  plan_change: "Plan upgrade",
  renewal: "Renewal",
  overage: "Extra emails",
  manual: "Invoice",
};

/** Yearly price as a monthly figure, for comparing plans. */
export const perMonth = (plan: Plan, interval: "month" | "year") =>
  interval === "year" && plan.price_yearly !== null ? Math.round(plan.price_yearly / 12) : plan.price_monthly;
