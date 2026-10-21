import { prisma, type BillingInterval, type Invoice, type Payment, type Plan, type Prisma } from "@tredmail/db";
import { env } from "../config/env.js";
import { recordAudit } from "../services/audit.js";
import { customerGateways, getGateway } from "./gateways/registry.js";
import { GatewayError, type IncomingPayment, type NextAction, type PaymentUpdate } from "./gateways/types.js";
import { amountDue, computeTotals, createInvoice, normalizeReference, type LineInput } from "./invoices.js";
import { formatMoney, roundForCurrency } from "./money.js";
import {
  notifyInvoiceIssued,
  notifyOps,
  notifyPaymentFailed,
  notifyPaymentReceived,
  notifyPlanChange,
  formatDay,
} from "./notify.js";
import { addDays, addInterval, remainingFraction, usageWindowAt, utcDay } from "./periods.js";
import { classifyChange, FREE_PLAN_ID, overageCharge, planPrice, resolveEntitlements, type PlanChange } from "./plans.js";
import { ensureBillingAccount, ensureSubscription, type SubscriptionWithPlan } from "./subscriptions.js";
import { usageBetween } from "./usage.js";

type Tx = Prisma.TransactionClient;
export type BillingFailure = { ok: false; statusCode: number; error: string; message: string };
const fail = (statusCode: number, error: string, message: string): BillingFailure => ({ ok: false, statusCode, error, message });

/** Side effects (emails) to run once the transaction that caused them has committed. */
type AfterCommit = Array<() => Promise<unknown>>;
async function runAfterCommit(tasks: AfterCommit) {
  for (const task of tasks) await task().catch((err) => console.error("[billing] follow-up failed", err));
}

const CHECKOUT_DUE_DAYS = 2;
const intervalLabel = (interval: BillingInterval) => (interval === "YEAR" ? "yearly" : "monthly");

// ---------------------------------------------------------------------------------------------
// Plans and plan changes
// ---------------------------------------------------------------------------------------------

export async function listPlans(options: { includeHidden?: boolean } = {}) {
  return prisma.plan.findMany({
    where: options.includeHidden ? {} : { isPublic: true, isActive: true },
    orderBy: { sortOrder: "asc" },
  });
}

export interface ChangePreview {
  ok: true;
  change: Exclude<PlanChange, "none">;
  effective: "now" | "period_end";
  effectiveAt: Date;
  plan: Plan;
  interval: BillingInterval;
  currency: string;
  lines: Array<LineInput & { amount: number }>;
  subtotal: number;
  tax: number;
  total: number;
  /** Credit for the unused period that exceeds the new price; kept as account credit */
  creditToBalance: number;
  periodStart: Date;
  periodEnd: Date;
}

async function resolveTarget(planId: string, interval: BillingInterval, allowHidden: boolean): Promise<{ ok: true; plan: Plan; price: number } | BillingFailure> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive || (!plan.isPublic && !allowHidden)) return fail(404, "plan_not_found", `There is no plan '${planId}' to choose.`);
  const price = planPrice(plan, interval);
  if (price === null) return fail(422, "interval_unavailable", `The ${plan.name} plan is not offered with ${intervalLabel(interval)} billing.`);
  return { ok: true, plan, price };
}

function creditFor(subscription: SubscriptionWithPlan, now: Date): number {
  if (subscription.periodAmountPaid <= 0) return 0;
  const fraction = remainingFraction(subscription.currentPeriodStart, subscription.currentPeriodEnd, now);
  return roundForCurrency(subscription.periodAmountPaid * fraction, subscription.plan.currency);
}

export async function previewPlanChange(organizationId: string, planId: string, interval: BillingInterval, now = new Date()): Promise<ChangePreview | BillingFailure> {
  const subscription = await ensureSubscription(organizationId);
  if (!subscription.plan.isPublic) {
    return fail(403, "plan_managed_by_dovepeak", `The ${subscription.plan.name} plan is arranged with Dovepeak. Contact Dovepeak to change it.`);
  }
  const target = await resolveTarget(planId, interval, false);
  if (!target.ok) return target;
  const change = classifyChange(subscription, { plan: target.plan, interval });
  if (change === "none") return fail(409, "no_change", `This workspace is already on the ${target.plan.name} plan, billed ${intervalLabel(interval)}.`);

  const effectiveNow = change === "upgrade" && target.price > 0;
  if (!effectiveNow) {
    return {
      ok: true,
      change,
      effective: "period_end",
      effectiveAt: subscription.currentPeriodEnd,
      plan: target.plan,
      interval,
      currency: target.plan.currency,
      lines: [],
      subtotal: 0,
      tax: 0,
      total: 0,
      creditToBalance: 0,
      periodStart: subscription.currentPeriodEnd,
      periodEnd: addInterval(subscription.currentPeriodEnd, interval),
    };
  }

  const periodStart = utcDay(now);
  const periodEnd = addInterval(periodStart, interval);
  const sameCurrency = subscription.plan.currency === target.plan.currency;
  const credit = sameCurrency ? creditFor(subscription, now) : 0;
  const creditUsed = Math.min(credit, target.price);
  const lines: LineInput[] = [
    {
      kind: "plan",
      description: `${target.plan.name} plan, billed ${intervalLabel(interval)} (${formatDay(periodStart)} to ${formatDay(periodEnd)})`,
      unitAmount: target.price,
      periodStart,
      periodEnd,
    },
  ];
  if (creditUsed > 0) {
    lines.push({ kind: "credit", description: `Unused time on the ${subscription.plan.name} plan`, unitAmount: -creditUsed });
  }
  const totals = computeTotals(lines, target.plan.currency);
  return {
    ok: true,
    change,
    effective: "now",
    effectiveAt: now,
    plan: target.plan,
    interval,
    currency: target.plan.currency,
    lines: totals.lines,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    creditToBalance: credit - creditUsed,
    periodStart,
    periodEnd,
  };
}

export type ChangeResult =
  | { ok: true; effective: "now"; invoice: Invoice; paid: boolean }
  | { ok: true; effective: "period_end"; effectiveAt: Date; plan: Plan };

/**
 * Starts a plan change. Upgrades produce a checkout invoice (the plan changes when it is
 * paid); downgrades, and moving to Free, are scheduled for the end of the paid period.
 */
export async function changePlan(
  organizationId: string,
  planId: string,
  interval: BillingInterval,
  actor: { userId: string | null; ip?: string },
  now = new Date(),
): Promise<ChangeResult | BillingFailure> {
  const preview = await previewPlanChange(organizationId, planId, interval, now);
  if (!preview.ok) return preview;
  const subscription = await ensureSubscription(organizationId);

  if (preview.effective === "period_end") {
    const toFree = planPrice(preview.plan, interval) === 0;
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: toFree
          ? { cancelAtPeriodEnd: true, pendingPlanId: null, pendingInterval: null }
          : { cancelAtPeriodEnd: false, pendingPlanId: preview.plan.id, pendingInterval: interval },
      });
      // A renewal already issued for the next period was priced for the old plan
      await voidRenewalFor(tx, organizationId, subscription.currentPeriodEnd);
    });
    await recordAudit({
      organizationId,
      actorType: actor.userId ? "user" : "system",
      actorId: actor.userId,
      action: "billing.plan_change_scheduled",
      metadata: { from: subscription.planId, to: preview.plan.id, interval, effective_at: preview.effectiveAt.toISOString() },
      ipAddress: actor.ip,
    });
    return { ok: true, effective: "period_end", effectiveAt: preview.effectiveAt, plan: preview.plan };
  }

  const after: AfterCommit = [];
  const invoice = await prisma.$transaction(async (tx) => {
    await tx.invoice.updateMany({
      where: { organizationId, purpose: "plan_change", status: "OPEN", amountPaid: 0 },
      data: { status: "VOID", voidedAt: now },
    });
    const created = await createInvoice(tx, {
      organizationId,
      subscriptionId: subscription.id,
      purpose: "plan_change",
      currency: preview.currency,
      lines: preview.lines,
      dueAt: addDays(now, CHECKOUT_DUE_DAYS),
      periodStart: preview.periodStart,
      periodEnd: preview.periodEnd,
      metadata: { planId: preview.plan.id, interval, fromPlanId: subscription.planId, creditToBalance: preview.creditToBalance },
    });
    return applyAccountCredit(tx, created, after, now);
  });
  await runAfterCommit(after);
  await recordAudit({
    organizationId,
    actorType: actor.userId ? "user" : "system",
    actorId: actor.userId,
    action: "billing.checkout_started",
    targetType: "invoice",
    targetId: invoice.id,
    metadata: { from: subscription.planId, to: preview.plan.id, interval, total: invoice.total },
    ipAddress: actor.ip,
  });
  return { ok: true, effective: "now", invoice, paid: invoice.status === "PAID" };
}

/** Undoes a scheduled downgrade or cancellation. */
export async function keepCurrentPlan(organizationId: string, actor: { userId: string | null; ip?: string }) {
  const subscription = await ensureSubscription(organizationId);
  if (!subscription.cancelAtPeriodEnd && !subscription.pendingPlanId) {
    return fail(409, "nothing_scheduled", "No plan change is scheduled.");
  }
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: false, pendingPlanId: null, pendingInterval: null },
  });
  await recordAudit({ organizationId, actorType: "user", actorId: actor.userId, action: "billing.plan_change_canceled", ipAddress: actor.ip });
  return { ok: true as const };
}

async function voidRenewalFor(tx: Tx, organizationId: string, periodStart: Date) {
  await tx.invoice.updateMany({
    where: { organizationId, purpose: "renewal", status: "OPEN", amountPaid: 0, periodStart },
    data: { status: "VOID", voidedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------------------------
// Applying money to invoices
// ---------------------------------------------------------------------------------------------

/** Uses the workspace's credit balance towards a new invoice, recorded as a credit payment. */
export async function applyAccountCredit(tx: Tx, invoice: Invoice, after: AfterCommit, now = new Date()): Promise<Invoice> {
  const account = await ensureBillingAccount(invoice.organizationId, tx);
  const due = amountDue(invoice);
  if (due === 0) return settleIfPaid(tx, invoice, after, now);
  const use = Math.min(account.creditBalance, due);
  if (use <= 0) return invoice;
  await tx.billingAccount.update({ where: { id: account.id }, data: { creditBalance: { decrement: use } } });
  const payment = await tx.payment.create({
    data: {
      organizationId: invoice.organizationId,
      invoiceId: invoice.id,
      gateway: "credit",
      method: "account_credit",
      status: "SUCCEEDED",
      amount: use,
      currency: invoice.currency,
      completedAt: now,
    },
  });
  return addPaymentToInvoice(tx, payment, after, now);
}

async function settleIfPaid(tx: Tx, invoice: Invoice, after: AfterCommit, now: Date): Promise<Invoice> {
  if (invoice.status !== "OPEN" || invoice.amountPaid < invoice.total) return invoice;
  const paid = await tx.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt: now } });
  await fulfillInvoice(tx, paid, after, now);
  return paid;
}

/**
 * Credits a succeeded payment to its invoice under a row lock. Money beyond what the invoice
 * needs (or paid against an invoice that is no longer open) becomes account credit.
 */
async function addPaymentToInvoice(tx: Tx, payment: Payment, after: AfterCommit, now: Date): Promise<Invoice> {
  const [locked] = await tx.$queryRaw<Invoice[]>`SELECT * FROM "invoices" WHERE "id" = ${payment.invoiceId} FOR UPDATE`;
  if (!locked) throw new Error(`invoice ${payment.invoiceId} not found`);
  if (locked.status !== "OPEN") {
    await creditBalance(tx, payment.organizationId!, payment.amount);
    return locked;
  }
  const newPaid = locked.amountPaid + payment.amount;
  const excess = Math.max(0, newPaid - locked.total);
  const invoice = await tx.invoice.update({ where: { id: locked.id }, data: { amountPaid: newPaid - excess } });
  if (excess > 0) await creditBalance(tx, payment.organizationId!, excess);
  return settleIfPaid(tx, invoice, after, now);
}

async function creditBalance(tx: Tx, organizationId: string, amount: number) {
  if (amount <= 0) return;
  const account = await ensureBillingAccount(organizationId, tx);
  await tx.billingAccount.update({ where: { id: account.id }, data: { creditBalance: { increment: amount } } });
}

/** Applies what a paid invoice was for: the new plan, or the renewed period. */
async function fulfillInvoice(tx: Tx, invoice: Invoice, after: AfterCommit, now: Date) {
  const meta = (invoice.metadata ?? {}) as { planId?: string; interval?: BillingInterval; creditToBalance?: number };
  const subscription = await tx.subscription.findUnique({ where: { organizationId: invoice.organizationId }, include: { plan: true } });

  if (invoice.purpose === "plan_change" && subscription && meta.planId) {
    const interval = meta.interval ?? "MONTH";
    await closeCurrentWindow(tx, subscription, now, after);
    const start = utcDay(now);
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: meta.planId,
        interval,
        status: "ACTIVE",
        currentPeriodStart: start,
        currentPeriodEnd: addInterval(start, interval),
        periodAmountPaid: invoice.subtotal,
        cancelAtPeriodEnd: false,
        pendingPlanId: null,
        pendingInterval: null,
        pastDueSince: null,
        customPrice: null,
        customMonthlyEmails: null,
        customDailyEmails: null,
        customMaxDomains: null,
        customMaxMembers: null,
        usageAlertLevel: 0,
        usageClosedThrough: start,
      },
    });
    await voidRenewalFor(tx, invoice.organizationId, subscription.currentPeriodEnd);
    await creditBalance(tx, invoice.organizationId, meta.creditToBalance ?? 0);
    after.push(() =>
      recordAudit({
        organizationId: invoice.organizationId,
        actorType: "system",
        action: "billing.plan_changed",
        targetType: "invoice",
        targetId: invoice.id,
        metadata: { from: subscription.planId, to: meta.planId!, interval },
      }),
    );
  }

  if (invoice.purpose === "renewal" && subscription && invoice.periodStart && subscription.currentPeriodStart.getTime() === invoice.periodStart.getTime()) {
    await tx.subscription.update({ where: { id: subscription.id }, data: { periodAmountPaid: invoice.subtotal } });
  }
  await refreshPastDue(tx, invoice.organizationId, now);
}

/** Bills overage for the usage window in progress (before a plan change ends it early). */
async function closeCurrentWindow(tx: Tx, subscription: SubscriptionWithPlan, now: Date, after: AfterCommit) {
  const window = usageWindowAt(subscription.currentPeriodStart, subscription.currentPeriodEnd, now);
  const end = utcDay(now);
  if (end <= window.start) return;
  await billOverage(tx, subscription, { start: window.start, end }, after, now);
}

/** Creates an overage invoice for a closed usage window, when the plan bills extra emails. */
export async function billOverage(
  tx: Tx,
  subscription: SubscriptionWithPlan,
  window: { start: Date; end: Date },
  after: AfterCommit,
  now: Date,
): Promise<Invoice | null> {
  const entitlements = resolveEntitlements(subscription);
  if (entitlements.overagePricePer1000 === null || entitlements.monthlyEmails === 0) return null;
  const used = await usageBetween(subscription.organizationId, window.start, window.end);
  const overage = overageCharge(used, entitlements);
  if (overage.amount <= 0) return null;
  const created = await createInvoice(tx, {
    organizationId: subscription.organizationId,
    subscriptionId: subscription.id,
    purpose: "overage",
    currency: entitlements.currency,
    dueAt: addDays(now, env.BILLING_GRACE_DAYS),
    periodStart: window.start,
    periodEnd: window.end,
    lines: [
      {
        kind: "overage",
        description: `${overage.extraEmails.toLocaleString("en-US")} extra emails on the ${entitlements.planName} plan (${formatDay(window.start)} to ${formatDay(addDays(window.end, -1))}), per 1,000`,
        quantity: overage.blocks,
        unitAmount: entitlements.overagePricePer1000,
        periodStart: window.start,
        periodEnd: window.end,
      },
    ],
    metadata: { used, included: entitlements.monthlyEmails },
  });
  const invoice = await applyAccountCredit(tx, created, after, now);
  after.push(() => notifyInvoiceIssued(invoice.id));
  return invoice;
}

/** PAST_DUE while a renewal or overage invoice is past its due date; ACTIVE otherwise. */
export async function refreshPastDue(tx: Tx, organizationId: string, now = new Date()) {
  const overdue = await tx.invoice.count({
    where: { organizationId, status: "OPEN", purpose: { in: ["renewal", "overage"] }, dueAt: { lte: now } },
  });
  const subscription = await tx.subscription.findUnique({ where: { organizationId } });
  if (!subscription) return;
  if (overdue > 0 && subscription.status === "ACTIVE") {
    await tx.subscription.update({ where: { id: subscription.id }, data: { status: "PAST_DUE", pastDueSince: now } });
  } else if (overdue === 0 && subscription.status === "PAST_DUE") {
    await tx.subscription.update({ where: { id: subscription.id }, data: { status: "ACTIVE", pastDueSince: null } });
  }
}

// ---------------------------------------------------------------------------------------------
// Collecting payments through gateways
// ---------------------------------------------------------------------------------------------

export interface StartPaymentResult {
  ok: true;
  payment: Payment;
  nextAction: NextAction | null;
}

/** Asks the gateway to collect what is due on an invoice (for M-Pesa: a PIN prompt). */
export async function startPayment(
  organizationId: string,
  invoiceId: string,
  gatewayId: string,
  payerInput: Record<string, unknown>,
  actor: { userId: string | null },
  now = new Date(),
): Promise<StartPaymentResult | BillingFailure> {
  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, organizationId } });
  if (!invoice) return fail(404, "not_found", "Invoice not found.");
  if (invoice.status !== "OPEN") return fail(409, "invoice_not_open", `This invoice is ${invoice.status.toLowerCase()}.`);
  const due = amountDue(invoice);
  if (due <= 0) return fail(409, "nothing_due", "Nothing is due on this invoice.");

  const gateway = customerGateways(invoice.currency).find((g) => g.id === gatewayId);
  if (!gateway?.initiate) return fail(422, "gateway_unavailable", `Payments with '${gatewayId}' are not available for ${invoice.currency} invoices.`);
  const payer = gateway.normalizePayer(payerInput);
  if (!payer.ok) return fail(422, "invalid_payer", payer.message);

  // A second click while the first prompt is still on the phone returns the same attempt
  const recent = await prisma.payment.findFirst({
    where: { invoiceId, gateway: gateway.id, status: "PENDING", createdAt: { gt: new Date(now.getTime() - 90_000) } },
    orderBy: { createdAt: "desc" },
  });
  if (recent) return { ok: true, payment: recent, nextAction: { type: "await_customer", message: "A payment request is already waiting on the phone. Enter your PIN to complete it." } };

  let payment = await prisma.payment.create({
    data: {
      organizationId,
      invoiceId,
      gateway: gateway.id,
      method: gateway.method,
      amount: due,
      currency: invoice.currency,
      payerPhone: payer.payer.phone,
      initiatedById: actor.userId,
    },
  });
  if (payer.payer.phone && actor.userId) {
    await prisma.billingAccount.updateMany({ where: { organizationId }, data: { phone: payer.payer.phone } });
  }

  try {
    const result = await gateway.initiate({
      paymentId: payment.id,
      amount: due,
      currency: invoice.currency,
      reference: invoice.number,
      description: "TredMail",
      payer: payer.payer,
    });
    if (result.status === "failed") {
      payment = await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED", failureCode: result.code, failureMessage: result.message, raw: (result.raw ?? undefined) as Prisma.InputJsonValue | undefined },
      });
      return { ok: true, payment, nextAction: null };
    }
    payment = await prisma.payment.update({
      where: { id: payment.id },
      data: { providerReference: result.providerReference, raw: (result.raw ?? undefined) as Prisma.InputJsonValue | undefined },
    });
    if (result.status === "succeeded") {
      await applyPaymentUpdate(gateway.id, { providerReference: result.providerReference, status: "succeeded", receipt: result.receipt });
      payment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      return { ok: true, payment, nextAction: null };
    }
    return { ok: true, payment, nextAction: result.nextAction };
  } catch (err) {
    const code = err instanceof GatewayError ? err.code : "gateway_error";
    payment = await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "FAILED", failureCode: code, failureMessage: (err as Error).message },
    });
    console.error(`[billing] ${gateway.id} payment ${payment.id} could not start`, err);
    return { ok: true, payment, nextAction: null };
  }
}

export type UpdateOutcome = "unknown_payment" | "pending" | "failed" | "succeeded" | "already_final";

/** Applies a gateway's report on a payment TredMail started. Safe to call more than once. */
export async function applyPaymentUpdate(gatewayId: string, update: PaymentUpdate, now = new Date()): Promise<UpdateOutcome> {
  const payment = await prisma.payment.findUnique({
    where: { gateway_providerReference: { gateway: gatewayId, providerReference: update.providerReference } },
  });
  if (!payment) return "unknown_payment";
  if (update.status === "pending") return "pending";
  if (payment.status === "SUCCEEDED" || payment.status === "REFUNDED") return "already_final";

  if (update.status === "failed") {
    if (payment.status !== "PENDING") return "already_final";
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "FAILED",
        failureCode: update.code ?? "failed",
        failureMessage: update.message ?? "The payment was not completed.",
        raw: (update.raw ?? undefined) as Prisma.InputJsonValue | undefined,
        completedAt: now,
      },
    });
    // Customers paying in the console see the failure there; tell them by email when the
    // request was sent automatically.
    if (!payment.initiatedById) await notifyPaymentFailed(payment.id);
    return "failed";
  }

  // A success may arrive after TredMail gave up on the attempt (a late PIN entry): accept it.
  const after: AfterCommit = [];
  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ["PENDING", "FAILED"] } },
      data: {
        status: "SUCCEEDED",
        amount: update.amount ?? payment.amount,
        providerReceipt: update.receipt ?? null,
        payerPhone: update.payerPhone ?? payment.payerPhone,
        payerName: update.payerName ?? payment.payerName,
        failureCode: null,
        failureMessage: null,
        raw: (update.raw ?? undefined) as Prisma.InputJsonValue | undefined,
        completedAt: now,
      },
    });
    if (claimed.count === 0) return null;
    const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (fresh.invoiceId) await addPaymentToInvoice(tx, fresh, after, now);
    else await creditBalance(tx, fresh.organizationId!, fresh.amount);
    return fresh;
  });
  if (!applied) return "already_final";
  await runAfterCommit(after);
  await notifyPaymentReceived(applied.id);
  return "succeeded";
}

/**
 * Applies a SUCCEEDED payment that is already recorded (staff-recorded payments, payments
 * assigned to a workspace after arriving unmatched) to its invoice or the credit balance.
 */
export async function applyRecordedPayment(paymentId: string, now = new Date(), options: { notify?: boolean } = {}) {
  const after: AfterCommit = [];
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (payment.status !== "SUCCEEDED" || !payment.organizationId) return;
    if (payment.invoiceId) await addPaymentToInvoice(tx, payment, after, now);
    else await creditBalance(tx, payment.organizationId, payment.amount);
  });
  await runAfterCommit(after);
  if (options.notify !== false) await notifyPaymentReceived(paymentId);
}

/** Matches what a payer typed as the account number to a workspace and invoice. */
export async function matchReference(reference: string) {
  const ref = normalizeReference(reference);
  if (!ref) return null;
  const invoice = await prisma.invoice.findUnique({ where: { number: ref } });
  if (invoice) return { organizationId: invoice.organizationId, invoice };
  const account = await prisma.billingAccount.findUnique({ where: { accountCode: ref } });
  if (!account) return null;
  const oldestOpen = await prisma.invoice.findFirst({
    where: { organizationId: account.organizationId, status: "OPEN" },
    orderBy: { dueAt: "asc" },
  });
  return { organizationId: account.organizationId, invoice: oldestOpen };
}

/** Whether to accept a payment the customer is making by hand (Paybill validation). */
export async function validateIncomingPayment(reference: string): Promise<boolean> {
  return (await matchReference(reference)) !== null;
}

export type IncomingOutcome = "duplicate" | "applied" | "unmatched";

/** Records money the customer sent by hand (Paybill) and applies it to the matching invoice. */
export async function recordIncomingPayment(gatewayId: string, incoming: IncomingPayment, now = new Date()): Promise<IncomingOutcome> {
  const existing = await prisma.payment.findUnique({
    where: { gateway_providerReceipt: { gateway: gatewayId, providerReceipt: incoming.receipt } },
  });
  if (existing) return "duplicate";
  const match = await matchReference(incoming.accountReference);
  const invoiceId = match?.invoice?.id ?? null;

  const after: AfterCommit = [];
  let paymentId: string;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          organizationId: match?.organizationId ?? null,
          invoiceId,
          gateway: gatewayId,
          method: incoming.method,
          status: "SUCCEEDED",
          amount: incoming.amount,
          currency: incoming.currency,
          providerReceipt: incoming.receipt,
          accountReference: incoming.accountReference,
          payerPhone: incoming.payerPhone,
          payerName: incoming.payerName,
          raw: (incoming.raw ?? undefined) as Prisma.InputJsonValue | undefined,
          completedAt: incoming.paidAt,
        },
      });
      if (match) {
        if (payment.invoiceId) await addPaymentToInvoice(tx, payment, after, now);
        else await creditBalance(tx, match.organizationId, payment.amount);
      }
      return payment;
    });
    paymentId = result.id;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return "duplicate";
    throw err;
  }
  await runAfterCommit(after);
  if (!match) {
    await notifyOps(
      "Unmatched payment received",
      `${formatMoney(incoming.amount, incoming.currency)} arrived with account number '${incoming.accountReference}', which matches no invoice or workspace.`,
      [
        `Receipt ${incoming.receipt} from ${incoming.payerName ?? "an unknown payer"} (${incoming.payerPhone ?? "no phone"}).`,
        "Assign it to the right workspace in the back-office under Payments.",
      ],
    );
    return "unmatched";
  }
  await notifyPaymentReceived(paymentId);
  return "applied";
}

/**
 * Asks gateways about payments still waiting for an answer (missed callbacks) and closes
 * attempts that can no longer complete.
 */
export async function reconcilePendingPayments(now = new Date()) {
  const pending = await prisma.payment.findMany({
    where: { status: "PENDING", providerReference: { not: null }, createdAt: { lt: new Date(now.getTime() - 60_000), gt: new Date(now.getTime() - 24 * 3600_000) } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const outcomes: Record<string, number> = {};
  for (const payment of pending) {
    const gateway = getGateway(payment.gateway);
    if (!gateway?.query) continue;
    try {
      const update = await gateway.query(payment.providerReference!);
      // The customer gets about a minute to answer the prompt; keep asking for 15 minutes.
      const giveUp = update.status === "pending" && payment.createdAt < new Date(now.getTime() - 15 * 60_000);
      const outcome = await applyPaymentUpdate(
        payment.gateway,
        giveUp ? { providerReference: payment.providerReference!, status: "failed", code: "timeout", message: "No answer was received for the payment request." } : update,
        now,
      );
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    } catch (err) {
      console.warn(`[billing] could not query payment ${payment.id}: ${(err as Error).message}`);
    }
  }
  const stuck = await prisma.payment.updateMany({
    where: {
      status: "PENDING",
      OR: [{ providerReference: null, createdAt: { lt: new Date(now.getTime() - 10 * 60_000) } }, { createdAt: { lt: new Date(now.getTime() - 24 * 3600_000) } }],
    },
    data: { status: "FAILED", failureCode: "expired", failureMessage: "The payment request expired.", completedAt: now },
  });
  return { checked: pending.length, outcomes, expired: stuck.count };
}

// ---------------------------------------------------------------------------------------------
// Invoices issued by the billing cycle
// ---------------------------------------------------------------------------------------------

/** The renewal invoice for the period starting at the end of the current one. */
export async function issueRenewalInvoice(subscription: SubscriptionWithPlan, now = new Date()): Promise<Invoice | null> {
  const nextPlanId = subscription.cancelAtPeriodEnd ? FREE_PLAN_ID : (subscription.pendingPlanId ?? subscription.planId);
  const interval = subscription.cancelAtPeriodEnd ? "MONTH" : (subscription.pendingInterval ?? subscription.interval);
  const plan = nextPlanId === subscription.planId ? subscription.plan : await prisma.plan.findUnique({ where: { id: nextPlanId } });
  if (!plan) return null;
  const sameDeal = nextPlanId === subscription.planId && interval === subscription.interval;
  const price = sameDeal && subscription.customPrice !== null ? subscription.customPrice : (planPrice(plan, interval) ?? 0);
  if (price <= 0) return null;

  const periodStart = subscription.currentPeriodEnd;
  const existing = await prisma.invoice.findFirst({
    where: { organizationId: subscription.organizationId, purpose: "renewal", periodStart, status: { not: "VOID" } },
  });
  if (existing) return null;

  const periodEnd = addInterval(periodStart, interval);
  const after: AfterCommit = [];
  const invoice = await prisma.$transaction(async (tx) => {
    const created = await createInvoice(tx, {
      organizationId: subscription.organizationId,
      subscriptionId: subscription.id,
      purpose: "renewal",
      currency: plan.currency,
      dueAt: periodStart,
      periodStart,
      periodEnd,
      lines: [
        {
          kind: "plan",
          description: `${plan.name} plan, billed ${intervalLabel(interval)} (${formatDay(periodStart)} to ${formatDay(periodEnd)})`,
          unitAmount: price,
          periodStart,
          periodEnd,
        },
      ],
      metadata: { planId: plan.id, interval },
    });
    return applyAccountCredit(tx, created, after, now);
  });
  await runAfterCommit(after);
  return invoice;
}

export { notifyInvoiceIssued, notifyPlanChange };
