import { prisma, type Invoice, type Payment } from "@tredmail/db";
import { env } from "../config/env.js";
import {
  invoiceIssuedTemplate,
  invoiceOverdueTemplate,
  paymentReceiptTemplate,
  paymentRequestFailedTemplate,
  planChangedTemplate,
  usageWarningTemplate,
  type PaybillDetails,
} from "../mail/billing-templates.js";
import { operationsAlertTemplate, type RenderedEmail } from "../mail/templates.js";
import { sendSystemEmail } from "../services/system-mailer.js";
import { maskPhone } from "./gateways/phone.js";
import { allGateways, getGateway } from "./gateways/registry.js";
import { amountDue } from "./invoices.js";
import { formatMoney } from "./money.js";
import { billingRecipients } from "./subscriptions.js";

const consoleUrl = (path: string, workspaceId: string) =>
  `${env.CONSOLE_URL.replace(/\/+$/, "")}${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspaceId)}`;

export const invoiceUrl = (invoice: Pick<Invoice, "id" | "organizationId">) => consoleUrl(`/billing/invoices/${invoice.id}`, invoice.organizationId);
export const billingUrl = (organizationId: string) => consoleUrl("/billing", organizationId);

export const formatDay = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: env.BILLING_TIMEZONE });

/** Pay-by-hand instructions from the first gateway that offers them (M-Pesa Paybill). */
export function offlineInstructionsFor(invoice: Pick<Invoice, "number" | "total" | "amountPaid" | "currency">) {
  for (const gateway of allGateways()) {
    if (!gateway.isConfigured() || gateway.staffOnly) continue;
    const instructions = gateway.offlineInstructions?.(invoice.number, amountDue(invoice), invoice.currency);
    if (instructions) return { gateway: gateway.id, ...instructions };
  }
  return null;
}

async function deliver(organizationId: string, email: RenderedEmail, kind: string) {
  const recipients = await billingRecipients(organizationId);
  for (const to of recipients) {
    try {
      await sendSystemEmail(to, email);
    } catch (err) {
      console.error(`[billing] could not send ${kind} email to ${to}`, err);
    }
  }
}

const workspaceName = async (organizationId: string) =>
  (await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }))?.name ?? "your workspace";

function describeInvoice(invoice: Invoice & { lines?: Array<{ description: string; kind: string }> }) {
  const plan = invoice.lines?.find((l) => l.kind === "plan");
  if (plan) return plan.description;
  if (invoice.purpose === "overage") return "extra emails above your plan's allowance";
  return invoice.lines?.[0]?.description ?? "TredMail services";
}

export async function notifyInvoiceIssued(invoiceId: string, promptPhone?: string | null) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { lines: true } });
  if (!invoice || invoice.status !== "OPEN") return;
  const offline = offlineInstructionsFor(invoice);
  await deliver(
    invoice.organizationId,
    invoiceIssuedTemplate({
      workspace: await workspaceName(invoice.organizationId),
      number: invoice.number,
      amount: formatMoney(amountDue(invoice), invoice.currency),
      dueDate: formatDay(invoice.dueAt),
      description: describeInvoice(invoice),
      url: invoiceUrl(invoice),
      paybill: offline as PaybillDetails | null,
      promptPhone: promptPhone ? maskPhone(promptPhone) : null,
    }),
    "invoice",
  );
}

export async function notifyPaymentReceived(paymentId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { invoice: true } });
  if (!payment?.organizationId || payment.gateway === "credit") return;
  let planNote: string | null = null;
  const meta = (payment.invoice?.metadata ?? {}) as { planId?: string };
  if (payment.invoice?.status === "PAID" && payment.invoice.purpose === "plan_change" && meta.planId) {
    const plan = await prisma.plan.findUnique({ where: { id: meta.planId }, select: { name: true } });
    if (plan) planNote = `The workspace is now on the ${plan.name} plan.`;
  } else if (payment.invoice && payment.invoice.status === "OPEN") {
    planNote = `${formatMoney(amountDue(payment.invoice), payment.invoice.currency)} is still due on this invoice.`;
  }
  const target = payment.invoice ?? { id: "", organizationId: payment.organizationId };
  await deliver(
    payment.organizationId,
    paymentReceiptTemplate({
      workspace: await workspaceName(payment.organizationId),
      number: payment.invoice?.number ?? "account credit",
      amount: formatMoney(payment.amount, payment.currency),
      method: methodLabel(payment),
      receipt: payment.providerReceipt,
      paidAt: formatDay(payment.completedAt ?? new Date()),
      url: payment.invoice ? invoiceUrl(target) : billingUrl(payment.organizationId),
      planNote,
    }),
    "receipt",
  );
}

export function methodLabel(payment: Pick<Payment, "gateway" | "method" | "payerPhone">): string {
  const labels: Record<string, string> = {
    mpesa_stk: "M-Pesa",
    mpesa_paybill: "M-Pesa Paybill",
    bank_transfer: "Bank transfer",
    account_credit: "Account credit",
    cash: "Cash",
    cheque: "Cheque",
  };
  const base = labels[payment.method] ?? getGateway(payment.gateway)?.name ?? payment.method;
  return payment.payerPhone && /^\d{12}$/.test(payment.payerPhone) ? `${base} (${maskPhone(payment.payerPhone)})` : base;
}

export async function notifyPaymentFailed(paymentId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { invoice: true } });
  if (!payment?.invoice || !payment.organizationId || payment.invoice.status !== "OPEN") return;
  await deliver(
    payment.organizationId,
    paymentRequestFailedTemplate({
      workspace: await workspaceName(payment.organizationId),
      number: payment.invoice.number,
      amount: formatMoney(amountDue(payment.invoice), payment.invoice.currency),
      reason: payment.failureMessage ?? "it was not completed.",
      url: invoiceUrl(payment.invoice),
      paybill: offlineInstructionsFor(payment.invoice) as PaybillDetails | null,
    }),
    "payment failed",
  );
}

export async function notifyOverdue(invoiceId: string, planName: string, downgradeAt: Date) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.status !== "OPEN") return;
  await deliver(
    invoice.organizationId,
    invoiceOverdueTemplate({
      workspace: await workspaceName(invoice.organizationId),
      number: invoice.number,
      amount: formatMoney(amountDue(invoice), invoice.currency),
      planName,
      downgradeDate: formatDay(downgradeAt),
      url: invoiceUrl(invoice),
      paybill: offlineInstructionsFor(invoice) as PaybillDetails | null,
    }),
    "overdue",
  );
}

export async function notifyPlanChange(organizationId: string, heading: string, message: string) {
  const workspace = await workspaceName(organizationId);
  await deliver(organizationId, planChangedTemplate({ workspace, heading, message, url: billingUrl(organizationId) }), "plan change");
}

export async function notifyUsage(
  organizationId: string,
  p: { percent: number; used: number; limit: number; planName: string; resetAt: Date; billsExtra: boolean },
) {
  await deliver(
    organizationId,
    usageWarningTemplate({
      workspace: await workspaceName(organizationId),
      percent: p.percent,
      used: p.used.toLocaleString("en-US"),
      limit: p.limit.toLocaleString("en-US"),
      planName: p.planName,
      resetDate: formatDay(p.resetAt),
      billsExtra: p.billsExtra,
      url: billingUrl(organizationId),
    }),
    "usage",
  );
}

/** Billing problems staff must look at (unmatched Paybill payments, gateway failures). */
export async function notifyOps(title: string, summary: string, details: string[]) {
  console.warn(`[billing] ${title}: ${summary}`);
  if (!env.OPS_EMAIL) return;
  try {
    await sendSystemEmail(env.OPS_EMAIL, operationsAlertTemplate({ title, summary, details }));
  } catch (err) {
    console.error("[billing] could not send ops alert", err);
  }
}
