import { prisma, type BillingInterval, type Prisma } from "@tredmail/db";
import { recordAudit } from "../services/audit.js";
import { createInvoice, type LineInput } from "./invoices.js";
import { notifyInvoiceIssued, notifyPlanChange } from "./notify.js";
import { addDays, addInterval, utcDay } from "./periods.js";
import { planPrice } from "./plans.js";
import { applyAccountCredit, applyRecordedPayment, refreshPastDue, type BillingFailure } from "./service.js";
import { ensureBillingAccount, ensureSubscription } from "./subscriptions.js";

/**
 * Back-office operations for TredMail staff. Each one is audited in the workspace's log with
 * actorType "staff".
 */

const fail = (statusCode: number, error: string, message: string): BillingFailure => ({ ok: false, statusCode, error, message });
const staffAudit = (organizationId: string, staffId: string, action: string, metadata?: Prisma.InputJsonObject, target?: { type: string; id: string }) =>
  recordAudit({ organizationId, actorType: "staff", actorId: staffId, action, metadata, targetType: target?.type, targetId: target?.id });

export interface StaffPlanInput {
  planId: string;
  interval: BillingInterval;
  customPrice?: number | null;
  customMonthlyEmails?: number | null;
  customDailyEmails?: number | null;
  customMaxDomains?: number | null;
  customMaxMembers?: number | null;
  /** Start a fresh period today (default) or keep the current dates */
  restartPeriod?: boolean;
}

/** Puts a workspace on any plan without charging (enterprise deals, comps, corrections). */
export async function staffSetPlan(organizationId: string, input: StaffPlanInput, staffId: string) {
  const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
  if (!plan) return fail(404, "plan_not_found", `There is no plan '${input.planId}'.`);
  if (planPrice(plan, input.interval) === null && input.customPrice == null) {
    return fail(422, "interval_unavailable", `${plan.name} has no ${input.interval.toLowerCase()} price; set a custom price.`);
  }
  const subscription = await ensureSubscription(organizationId);
  const start = utcDay(new Date());
  const restart = input.restartPeriod !== false;
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      planId: plan.id,
      interval: input.interval,
      status: "ACTIVE",
      pastDueSince: null,
      cancelAtPeriodEnd: false,
      pendingPlanId: null,
      pendingInterval: null,
      customPrice: input.customPrice ?? null,
      customMonthlyEmails: input.customMonthlyEmails ?? null,
      customDailyEmails: input.customDailyEmails ?? null,
      customMaxDomains: input.customMaxDomains ?? null,
      customMaxMembers: input.customMaxMembers ?? null,
      ...(restart
        ? { currentPeriodStart: start, currentPeriodEnd: addInterval(start, input.interval), periodAmountPaid: 0, usageClosedThrough: start, usageAlertLevel: 0 }
        : {}),
    },
  });
  await staffAudit(organizationId, staffId, "billing.staff_plan_set", {
    from: subscription.planId,
    to: plan.id,
    interval: input.interval,
    custom_price: input.customPrice ?? null,
    custom_monthly_emails: input.customMonthlyEmails ?? null,
  });
  await notifyPlanChange(organizationId, `You are now on the ${plan.name} plan`, `Dovepeak moved the workspace to the ${plan.name} plan.`);
  return { ok: true as const };
}

export interface ManualPaymentInput {
  organizationId: string;
  invoiceId?: string | null;
  amount: number;
  currency: string;
  method: "bank_transfer" | "cash" | "cheque" | "mpesa_paybill" | "other";
  reference: string;
  note?: string;
}

/** Records money received outside the gateways (bank transfer, cheque) and applies it. */
export async function recordManualPayment(input: ManualPaymentInput, staffId: string) {
  if (input.invoiceId) {
    const invoice = await prisma.invoice.findFirst({ where: { id: input.invoiceId, organizationId: input.organizationId } });
    if (!invoice) return fail(404, "invoice_not_found", "That invoice does not belong to this workspace.");
    if (invoice.currency !== input.currency) return fail(422, "currency_mismatch", `The invoice is in ${invoice.currency}.`);
  }
  const duplicate = await prisma.payment.findUnique({ where: { gateway_providerReceipt: { gateway: "manual", providerReceipt: input.reference } } });
  if (duplicate) return fail(409, "duplicate_reference", `A payment with reference '${input.reference}' is already recorded.`);
  const payment = await prisma.payment.create({
    data: {
      organizationId: input.organizationId,
      invoiceId: input.invoiceId ?? null,
      gateway: "manual",
      method: input.method,
      status: "SUCCEEDED",
      amount: input.amount,
      currency: input.currency,
      providerReceipt: input.reference,
      initiatedById: staffId,
      raw: input.note ? { note: input.note } : undefined,
      completedAt: new Date(),
    },
  });
  await applyRecordedPayment(payment.id);
  await staffAudit(input.organizationId, staffId, "billing.payment_recorded", { amount: input.amount, method: input.method, reference: input.reference }, { type: "payment", id: payment.id });
  return { ok: true as const, payment };
}

/** Attaches a payment that arrived with an unknown account number to a workspace. */
export async function assignPayment(paymentId: string, organizationId: string, invoiceId: string | null, staffId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return fail(404, "not_found", "Payment not found.");
  if (payment.organizationId) return fail(409, "already_assigned", "This payment already belongs to a workspace.");
  if (payment.status !== "SUCCEEDED") return fail(409, "not_succeeded", "Only received payments can be assigned.");
  if (invoiceId) {
    const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, organizationId } });
    if (!invoice) return fail(404, "invoice_not_found", "That invoice does not belong to this workspace.");
  }
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
  if (!org) return fail(404, "workspace_not_found", "Workspace not found.");
  await prisma.payment.update({ where: { id: paymentId }, data: { organizationId, invoiceId } });
  await applyRecordedPayment(paymentId);
  await staffAudit(organizationId, staffId, "billing.payment_assigned", { amount: payment.amount, receipt: payment.providerReceipt }, { type: "payment", id: paymentId });
  return { ok: true as const };
}

/**
 * Records a refund made in the provider's portal (an M-Pesa reversal, a bank refund). The
 * invoice it paid is reopened for the refunded amount; the plan is left as it is.
 */
export async function refundPayment(paymentId: string, reason: string, staffId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return fail(404, "not_found", "Payment not found.");
  if (payment.status !== "SUCCEEDED") return fail(409, "not_refundable", "Only succeeded payments can be refunded.");
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { status: "REFUNDED", refundedAt: new Date(), failureMessage: reason } });
    if (payment.invoiceId) {
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
      const amountPaid = Math.max(0, invoice.amountPaid - payment.amount);
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { amountPaid, ...(invoice.status === "PAID" && amountPaid < invoice.total ? { status: "VOID", voidedAt: new Date() } : {}) },
      });
    } else if (payment.organizationId) {
      await tx.billingAccount.updateMany({ where: { organizationId: payment.organizationId }, data: { creditBalance: { decrement: payment.amount } } });
    }
  });
  if (payment.organizationId) {
    await staffAudit(payment.organizationId, staffId, "billing.payment_refunded", { amount: payment.amount, reason }, { type: "payment", id: paymentId });
  }
  return { ok: true as const };
}

export interface ManualInvoiceInput {
  lines: Array<{ description: string; quantity: number; unitAmount: number }>;
  currency: string;
  dueDays: number;
  notes?: string;
}

/** Raises an invoice by hand (enterprise terms, setup fees, corrections). */
export async function createManualInvoice(organizationId: string, input: ManualInvoiceInput, staffId: string) {
  const subscription = await ensureSubscription(organizationId);
  const now = new Date();
  const lines: LineInput[] = input.lines.map((l) => ({ kind: l.unitAmount < 0 ? "credit" : "adjustment", description: l.description, quantity: l.quantity, unitAmount: l.unitAmount }));
  const after: Array<() => Promise<unknown>> = [];
  const invoice = await prisma.$transaction(async (tx) => {
    const created = await createInvoice(tx, {
      organizationId,
      subscriptionId: subscription.id,
      purpose: "manual",
      currency: input.currency,
      lines,
      dueAt: addDays(now, input.dueDays),
      notes: input.notes,
    });
    return applyAccountCredit(tx, created, after, now);
  });
  for (const task of after) await task();
  await staffAudit(organizationId, staffId, "billing.invoice_created", { number: invoice.number, total: invoice.total }, { type: "invoice", id: invoice.id });
  if (invoice.status === "OPEN") await notifyInvoiceIssued(invoice.id);
  return { ok: true as const, invoice };
}

export async function voidInvoice(invoiceId: string, actor: { staffId?: string; userId?: string; organizationId?: string }) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || (actor.organizationId && invoice.organizationId !== actor.organizationId)) return fail(404, "not_found", "Invoice not found.");
  if (invoice.status !== "OPEN") return fail(409, "invoice_not_open", `This invoice is ${invoice.status.toLowerCase()}.`);
  if (!actor.staffId && invoice.purpose !== "plan_change") return fail(403, "cannot_void", "Only upgrade checkouts can be canceled. Contact Dovepeak about this invoice.");
  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: "VOID", voidedAt: new Date() } });
    if (invoice.amountPaid > 0) {
      await tx.billingAccount.updateMany({ where: { organizationId: invoice.organizationId }, data: { creditBalance: { increment: invoice.amountPaid } } });
    }
    await refreshPastDue(tx, invoice.organizationId);
  });
  await recordAudit({
    organizationId: invoice.organizationId,
    actorType: actor.staffId ? "staff" : "user",
    actorId: actor.staffId ?? actor.userId ?? null,
    action: "billing.invoice_voided",
    targetType: "invoice",
    targetId: invoiceId,
    metadata: { number: invoice.number },
  });
  return { ok: true as const };
}

export async function adjustCredit(organizationId: string, amount: number, reason: string, staffId: string) {
  const account = await ensureBillingAccount(organizationId);
  if (account.creditBalance + amount < 0) return fail(422, "negative_balance", "The credit balance cannot go below zero.");
  await prisma.billingAccount.update({ where: { id: account.id }, data: { creditBalance: { increment: amount } } });
  await staffAudit(organizationId, staffId, "billing.credit_adjusted", { amount, reason });
  return { ok: true as const };
}

export async function setSuspension(organizationId: string, suspend: boolean, reason: string | null, staffId: string) {
  await prisma.organization.update({
    where: { id: organizationId },
    data: suspend ? { suspendedAt: new Date(), suspendedReason: reason } : { suspendedAt: null, suspendedReason: null },
  });
  await staffAudit(organizationId, staffId, suspend ? "workspace.suspended" : "workspace.unsuspended", reason ? { reason } : undefined);
  return { ok: true as const };
}

export async function resumeSending(organizationId: string, staffId: string) {
  await prisma.organization.update({ where: { id: organizationId }, data: { sendingPausedAt: null, sendingPauseReason: null } });
  await staffAudit(organizationId, staffId, "workspace.sending_resumed");
  return { ok: true as const };
}
