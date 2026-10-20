import type { BillingAccount, Invoice, InvoiceLine, Payment, Plan } from "@tredmail/db";
import { maskPhone } from "./gateways/phone.js";
import { customerGateways, getGateway } from "./gateways/registry.js";
import { amountDue } from "./invoices.js";
import { methodLabel, offlineInstructionsFor } from "./notify.js";
import type { Entitlements } from "./plans.js";
import type { SubscriptionWithPlan } from "./subscriptions.js";
import type { UsageSummary } from "./usage.js";

/** API shapes (snake_case) shared by the billing, admin and public routes. */

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

export function serializePlan(plan: Plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    currency: plan.currency,
    price_monthly: plan.priceMonthly,
    price_yearly: plan.priceYearly,
    monthly_emails: plan.monthlyEmails,
    daily_emails: plan.dailyEmails,
    overage_price_per_1000: plan.overagePricePer1000,
    overage_limit: plan.overageLimit,
    max_domains: plan.maxDomains,
    max_members: plan.maxMembers,
    log_retention_days: plan.logRetentionDays,
    features: plan.features,
  };
}

export function serializeEntitlements(e: Entitlements) {
  return {
    plan: e.planId,
    plan_name: e.planName,
    currency: e.currency,
    interval: e.interval.toLowerCase(),
    price: e.price,
    monthly_emails: e.monthlyEmails,
    daily_emails: e.dailyEmails,
    overage_price_per_1000: e.overagePricePer1000,
    overage_limit: e.overageLimit,
    max_domains: e.maxDomains,
    max_members: e.maxMembers,
    log_retention_days: e.logRetentionDays,
  };
}

export function serializeUsage(summary: UsageSummary) {
  const e = summary.entitlements;
  return {
    period_start: summary.window.start.toISOString(),
    period_end: summary.window.end.toISOString(),
    emails_sent: summary.used,
    emails_today: summary.today,
    monthly_limit: e.monthlyEmails,
    daily_limit: e.dailyEmails,
    remaining: summary.remaining,
    overage_emails: e.monthlyEmails > 0 ? Math.max(0, summary.used - e.monthlyEmails) : 0,
  };
}

export function serializeSubscription(subscription: SubscriptionWithPlan, pendingPlan: Plan | null) {
  return {
    plan: serializePlan(subscription.plan),
    interval: subscription.interval.toLowerCase(),
    status: subscription.status.toLowerCase(),
    current_period_start: subscription.currentPeriodStart.toISOString(),
    current_period_end: subscription.currentPeriodEnd.toISOString(),
    cancel_at_period_end: subscription.cancelAtPeriodEnd,
    pending_change: pendingPlan
      ? { plan: pendingPlan.id, plan_name: pendingPlan.name, interval: (subscription.pendingInterval ?? subscription.interval).toLowerCase(), effective_at: subscription.currentPeriodEnd.toISOString() }
      : subscription.cancelAtPeriodEnd
        ? { plan: "free", plan_name: "Free", interval: "month", effective_at: subscription.currentPeriodEnd.toISOString() }
        : null,
    past_due_since: iso(subscription.pastDueSince),
    custom: {
      price: subscription.customPrice,
      monthly_emails: subscription.customMonthlyEmails,
      daily_emails: subscription.customDailyEmails,
      max_domains: subscription.customMaxDomains,
      max_members: subscription.customMaxMembers,
    },
  };
}

export function serializeBillingAccount(account: BillingAccount) {
  return {
    account_code: account.accountCode,
    billing_email: account.billingEmail,
    company_name: account.companyName,
    tax_id: account.taxId,
    address_line1: account.addressLine1,
    address_line2: account.addressLine2,
    city: account.city,
    country: account.country,
    phone: account.phone,
    phone_display: account.phone ? maskPhone(account.phone) : null,
    auto_collect: account.autoCollect,
    credit_balance: account.creditBalance,
  };
}

export function serializePayment(payment: Payment & { invoice?: Pick<Invoice, "number"> | null }, options: { staff?: boolean } = {}) {
  return {
    id: payment.id,
    invoice_id: payment.invoiceId,
    invoice_number: payment.invoice?.number ?? null,
    organization_id: options.staff ? payment.organizationId : undefined,
    gateway: payment.gateway,
    gateway_name: getGateway(payment.gateway)?.name ?? payment.gateway,
    method: payment.method,
    method_label: methodLabel(payment),
    status: payment.status.toLowerCase(),
    amount: payment.amount,
    currency: payment.currency,
    receipt: payment.providerReceipt,
    account_reference: payment.accountReference,
    payer_phone: payment.payerPhone ? (options.staff ? payment.payerPhone : maskPhone(payment.payerPhone)) : null,
    payer_name: payment.payerName,
    failure_code: payment.failureCode,
    failure_message: payment.failureMessage,
    created_at: payment.createdAt.toISOString(),
    completed_at: iso(payment.completedAt),
    refunded_at: iso(payment.refundedAt),
  };
}

export function serializeInvoiceSummary(invoice: Invoice) {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status.toLowerCase(),
    purpose: invoice.purpose,
    currency: invoice.currency,
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    total: invoice.total,
    amount_paid: invoice.amountPaid,
    amount_due: invoice.status === "OPEN" ? amountDue(invoice) : 0,
    period_start: iso(invoice.periodStart),
    period_end: iso(invoice.periodEnd),
    due_at: invoice.dueAt.toISOString(),
    paid_at: iso(invoice.paidAt),
    voided_at: iso(invoice.voidedAt),
    created_at: invoice.createdAt.toISOString(),
  };
}

export function serializeInvoice(invoice: Invoice & { lines: InvoiceLine[]; payments: Payment[] }, options: { staff?: boolean } = {}) {
  const open = invoice.status === "OPEN" && amountDue(invoice) > 0;
  return {
    ...serializeInvoiceSummary(invoice),
    tax_rate: invoice.taxRate / 100,
    billing_details: invoice.billingDetails,
    notes: invoice.notes,
    lines: invoice.lines.map((line) => ({
      kind: line.kind,
      description: line.description,
      quantity: line.quantity,
      unit_amount: line.unitAmount,
      amount: line.amount,
      period_start: iso(line.periodStart),
      period_end: iso(line.periodEnd),
    })),
    payments: invoice.payments
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => serializePayment(p, options)),
    pay_with: open ? serializeGatewayChoices(invoice.currency) : [],
    pay_offline: open ? offlineInstructionsFor(invoice) : null,
  };
}

export function serializeGatewayChoices(currency: string) {
  return customerGateways(currency).map((g) => ({
    id: g.id,
    name: g.name,
    fields: g.payerFields.map((f) => ({ name: f.name, label: f.label, placeholder: f.placeholder ?? null, hint: f.hint ?? null, type: f.type })),
  }));
}
