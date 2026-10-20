import { prisma, type BillingAccount, type Invoice, type InvoiceLine, type Prisma } from "@tredmail/db";
import { COMPANY } from "../config/company.js";
import { env } from "../config/env.js";
import { roundForCurrency, taxOn } from "./money.js";
import { ensureBillingAccount } from "./subscriptions.js";

type Tx = Prisma.TransactionClient;

export interface LineInput {
  kind: "plan" | "overage" | "credit" | "adjustment";
  description: string;
  quantity?: number;
  unitAmount: number;
  periodStart?: Date;
  periodEnd?: Date;
}

/** Invoice numbers: INV + two-digit year + five-digit sequence, e.g. INV2600042 (10 characters). */
export async function nextInvoiceNumber(tx: Tx, at = new Date()): Promise<string> {
  const year = at.getUTCFullYear();
  const [row] = await tx.$queryRaw<Array<{ last: number }>>`
    INSERT INTO "invoice_sequences" ("year", "last") VALUES (${year}, 1)
    ON CONFLICT ("year") DO UPDATE SET "last" = "invoice_sequences"."last" + 1
    RETURNING "last"`;
  return `INV${String(year).slice(2)}${String(row.last).padStart(5, "0")}`;
}

export const taxRateBasisPoints = () => Math.round(env.BILLING_TAX_RATE * 100);

export function computeTotals(lines: LineInput[], currency: string, taxRate = taxRateBasisPoints()) {
  const priced = lines.map((line) => {
    const quantity = line.quantity ?? 1;
    return { ...line, quantity, amount: roundForCurrency(line.unitAmount * quantity, currency) };
  });
  const subtotal = Math.max(0, priced.reduce((sum, line) => sum + line.amount, 0));
  const tax = taxOn(subtotal, taxRate, currency);
  return { lines: priced, subtotal, taxRate, tax, total: subtotal + tax };
}

export interface BillingDetails {
  customer: {
    workspace: string;
    name: string;
    email: string | null;
    taxId: string | null;
    address: string[];
    accountCode: string;
  };
  seller: { name: string; address: string; website: string; taxId: string | null; email: string | null };
  taxLabel: string;
}

export function billingSnapshot(account: BillingAccount, workspaceName: string): BillingDetails {
  return {
    customer: {
      workspace: workspaceName,
      name: account.companyName || workspaceName,
      email: account.billingEmail,
      taxId: account.taxId,
      address: [account.addressLine1, account.addressLine2, account.city, account.country].filter((part): part is string => Boolean(part)),
      accountCode: account.accountCode,
    },
    seller: {
      name: COMPANY.name,
      address: COMPANY.postalAddress,
      website: COMPANY.website,
      taxId: env.BILLING_TAX_ID ?? null,
      email: env.BILLING_SUPPORT_EMAIL ?? null,
    },
    taxLabel: env.BILLING_TAX_LABEL,
  };
}

export interface CreateInvoiceInput {
  organizationId: string;
  subscriptionId?: string | null;
  purpose: "plan_change" | "renewal" | "overage" | "manual";
  currency: string;
  lines: LineInput[];
  dueAt: Date;
  periodStart?: Date;
  periodEnd?: Date;
  metadata?: Prisma.InputJsonObject;
  notes?: string;
}

export async function createInvoice(tx: Tx, input: CreateInvoiceInput): Promise<Invoice & { lines: InvoiceLine[] }> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId }, select: { name: true } });
  const account = await ensureBillingAccount(input.organizationId, tx);
  const totals = computeTotals(input.lines, input.currency);
  return tx.invoice.create({
    data: {
      number: await nextInvoiceNumber(tx),
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId ?? null,
      purpose: input.purpose,
      currency: input.currency,
      subtotal: totals.subtotal,
      taxRate: totals.taxRate,
      tax: totals.tax,
      total: totals.total,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      dueAt: input.dueAt,
      billingDetails: billingSnapshot(account, org.name) as unknown as Prisma.InputJsonObject,
      metadata: input.metadata,
      notes: input.notes,
      lines: {
        create: totals.lines.map((line) => ({
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unitAmount,
          amount: line.amount,
          periodStart: line.periodStart,
          periodEnd: line.periodEnd,
        })),
      },
    },
    include: { lines: true },
  });
}

export const amountDue = (invoice: Pick<Invoice, "total" | "amountPaid">) => Math.max(0, invoice.total - invoice.amountPaid);

/** Finds an invoice by the reference a payer typed: invoice numbers ignore case, spaces and dashes. */
export function normalizeReference(reference: string): string {
  return reference.toUpperCase().replace(/[\s\-_.#]/g, "");
}

export async function findInvoiceByNumber(reference: string) {
  return prisma.invoice.findUnique({ where: { number: normalizeReference(reference) } });
}
