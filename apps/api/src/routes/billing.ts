import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@tredmail/db";
import { listPlans, changePlan, keepCurrentPlan, previewPlanChange, startPayment } from "@tredmail/core/billing/service";
import { voidInvoice } from "@tredmail/core/billing/admin";
import { ensureBillingAccount, getEntitlements } from "@tredmail/core/billing/subscriptions";
import { usageSummary } from "@tredmail/core/billing/usage";
import { normalizeKenyanPhone } from "@tredmail/core/billing/gateways/phone";
import {
  serializeBillingAccount,
  serializeEntitlements,
  serializeGatewayChoices,
  serializeInvoice,
  serializeInvoiceSummary,
  serializePayment,
  serializePlan,
  serializeSubscription,
  serializeUsage,
} from "@tredmail/core/billing/serialize";
import { recordAudit } from "@tredmail/core/services/audit";
import { auditActor, authenticate, requireBillingOwner, requireBillingViewer } from "../middleware/auth.js";

const intervalSchema = z.enum(["month", "year"]).transform((v) => (v === "year" ? "YEAR" : "MONTH") as "MONTH" | "YEAR");
const changeSchema = z.object({ plan: z.string().min(1).max(40), interval: intervalSchema.default("month") });

const accountSchema = z.object({
  billing_email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  company_name: z.string().trim().max(120).nullable().optional(),
  tax_id: z.string().trim().max(40).nullable().optional(),
  address_line1: z.string().trim().max(120).nullable().optional(),
  address_line2: z.string().trim().max(120).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  country: z.string().trim().length(2).toUpperCase().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  auto_collect: z.boolean().optional(),
});

const paySchema = z.object({ gateway: z.string().min(1).max(40), payer: z.record(z.string().max(200)).default({}) });

const bad = (details: unknown, message = "Invalid request.") => ({ statusCode: 400, error: "validation_error", message, details });
const empty = (v: string | null | undefined) => (v === undefined ? undefined : v || null);

/**
 * Console billing for the active workspace: plan, usage, invoices and payments. Session only
 * (not API keys). Owners and Admins can see it and pay invoices; only Owners change the plan.
 */
export async function billingRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", async (request, reply) => {
    if (request.principal?.kind !== "user") {
      return reply.status(403).send({ statusCode: 403, error: "session_required", message: "Billing is managed from the console, not with API keys." });
    }
  });
  fastify.addHook("preHandler", requireBillingViewer);

  // GET /v1/billing - Everything the billing page shows
  fastify.get("/billing", async (request) => {
    const orgId = request.organization!.id;
    const [{ subscription, entitlements }, usage, account, openInvoices, plans, org] = await Promise.all([
      getEntitlements(orgId),
      usageSummary(orgId),
      ensureBillingAccount(orgId),
      prisma.invoice.findMany({ where: { organizationId: orgId, status: "OPEN" }, orderBy: { dueAt: "asc" } }),
      listPlans(),
      prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { suspendedAt: true, suspendedReason: true, sendingPausedAt: true, sendingPauseReason: true } }),
    ]);
    const pendingPlan = subscription.pendingPlanId ? await prisma.plan.findUnique({ where: { id: subscription.pendingPlanId } }) : null;
    const principal = request.principal!;
    return {
      subscription: serializeSubscription(subscription, pendingPlan),
      entitlements: serializeEntitlements(entitlements),
      usage: serializeUsage(usage),
      account: serializeBillingAccount(account),
      open_invoices: openInvoices.map(serializeInvoiceSummary),
      plans: plans.map(serializePlan),
      gateways: serializeGatewayChoices(entitlements.currency),
      standing: {
        suspended: Boolean(org.suspendedAt),
        suspended_reason: org.suspendedReason,
        sending_paused: Boolean(org.sendingPausedAt),
        sending_pause_reason: org.sendingPauseReason,
      },
      can_manage: principal.kind === "user" && principal.role === "OWNER",
    };
  });

  // POST /v1/billing/preview - What a plan change would cost and when it applies
  fastify.post("/billing/preview", async (request, reply) => {
    const parsed = changeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.errors));
    const preview = await previewPlanChange(request.organization!.id, parsed.data.plan, parsed.data.interval);
    if (!preview.ok) return reply.status(preview.statusCode).send({ statusCode: preview.statusCode, error: preview.error, message: preview.message });
    return {
      change: preview.change,
      effective: preview.effective,
      effective_at: preview.effectiveAt.toISOString(),
      plan: serializePlan(preview.plan),
      interval: preview.interval.toLowerCase(),
      currency: preview.currency,
      lines: preview.lines.map((l) => ({ kind: l.kind, description: l.description, quantity: l.quantity ?? 1, amount: l.amount })),
      subtotal: preview.subtotal,
      tax: preview.tax,
      total: preview.total,
      credit_to_balance: preview.creditToBalance,
      period_start: preview.periodStart.toISOString(),
      period_end: preview.periodEnd.toISOString(),
    };
  });

  // POST /v1/billing/subscription - Change plan: upgrades return an invoice to pay
  fastify.post("/billing/subscription", { preHandler: requireBillingOwner }, async (request, reply) => {
    const parsed = changeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.errors));
    const actor = auditActor(request);
    const result = await changePlan(request.organization!.id, parsed.data.plan, parsed.data.interval, { userId: actor.actorId, ip: request.ip });
    if (!result.ok) return reply.status(result.statusCode).send({ statusCode: result.statusCode, error: result.error, message: result.message });
    if (result.effective === "period_end") {
      return { effective: "period_end", effective_at: result.effectiveAt.toISOString(), plan: result.plan.id, invoice: null };
    }
    return reply.status(201).send({ effective: "now", paid: result.paid, invoice: serializeInvoiceSummary(result.invoice) });
  });

  // POST /v1/billing/subscription/keep - Cancel a scheduled downgrade or move to Free
  fastify.post("/billing/subscription/keep", { preHandler: requireBillingOwner }, async (request, reply) => {
    const result = await keepCurrentPlan(request.organization!.id, { userId: auditActor(request).actorId, ip: request.ip });
    if (!result.ok) return reply.status(result.statusCode).send({ statusCode: result.statusCode, error: result.error, message: result.message });
    return { ok: true };
  });

  // PUT /v1/billing/account - Billing details and the M-Pesa number for payment requests
  fastify.put("/billing/account", { preHandler: requireBillingOwner }, async (request, reply) => {
    const parsed = accountSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.errors));
    const d = parsed.data;
    let phone: string | null | undefined = empty(d.phone);
    if (phone) {
      phone = normalizeKenyanPhone(phone);
      if (!phone) return reply.status(422).send({ statusCode: 422, error: "invalid_phone", message: "Enter a Safaricom number such as 0712 345 678." });
    }
    const orgId = request.organization!.id;
    await ensureBillingAccount(orgId);
    const account = await prisma.billingAccount.update({
      where: { organizationId: orgId },
      data: {
        billingEmail: empty(d.billing_email),
        companyName: empty(d.company_name),
        taxId: empty(d.tax_id),
        addressLine1: empty(d.address_line1),
        addressLine2: empty(d.address_line2),
        city: empty(d.city),
        country: d.country,
        phone,
        autoCollect: d.auto_collect,
      },
    });
    await recordAudit({ organizationId: orgId, ...auditActor(request), action: "billing.details_updated", ipAddress: request.ip });
    return serializeBillingAccount(account);
  });

  // GET /v1/billing/invoices
  fastify.get<{ Querystring: { status?: string } }>("/billing/invoices", async (request) => {
    const status = request.query.status?.toUpperCase();
    const invoices = await prisma.invoice.findMany({
      where: {
        organizationId: request.organization!.id,
        ...(status === "OPEN" || status === "PAID" || status === "VOID" ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { data: invoices.map(serializeInvoiceSummary) };
  });

  // GET /v1/billing/invoices/:id - Invoice with lines, payments and ways to pay
  fastify.get<{ Params: { id: string } }>("/billing/invoices/:id", async (request, reply) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: request.params.id, organizationId: request.organization!.id },
      include: { lines: true, payments: true },
    });
    if (!invoice) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Invoice not found." });
    return serializeInvoice(invoice);
  });

  // POST /v1/billing/invoices/:id/pay - Start a payment (M-Pesa: sends the PIN prompt)
  fastify.post<{ Params: { id: string } }>("/billing/invoices/:id/pay", async (request, reply) => {
    const parsed = paySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.errors));
    const result = await startPayment(request.organization!.id, request.params.id, parsed.data.gateway, parsed.data.payer, {
      userId: auditActor(request).actorId,
    });
    if (!result.ok) return reply.status(result.statusCode).send({ statusCode: result.statusCode, error: result.error, message: result.message });
    return reply.status(201).send({ payment: serializePayment(result.payment), next_action: result.nextAction });
  });

  // POST /v1/billing/invoices/:id/cancel - Abandon an upgrade checkout
  fastify.post<{ Params: { id: string } }>("/billing/invoices/:id/cancel", { preHandler: requireBillingOwner }, async (request, reply) => {
    const result = await voidInvoice(request.params.id, { userId: auditActor(request).actorId ?? undefined, organizationId: request.organization!.id });
    if (!result.ok) return reply.status(result.statusCode).send({ statusCode: result.statusCode, error: result.error, message: result.message });
    return { ok: true };
  });

  // GET /v1/billing/payments
  fastify.get("/billing/payments", async (request) => {
    const payments = await prisma.payment.findMany({
      where: { organizationId: request.organization!.id, gateway: { not: "credit" } },
      include: { invoice: { select: { number: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { data: payments.map((p) => serializePayment(p)) };
  });

  // GET /v1/billing/payments/:id - Polled by the console while the customer approves
  fastify.get<{ Params: { id: string } }>("/billing/payments/:id", async (request, reply) => {
    const payment = await prisma.payment.findFirst({
      where: { id: request.params.id, organizationId: request.organization!.id },
      include: { invoice: true },
    });
    if (!payment) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Payment not found." });
    return { payment: serializePayment(payment), invoice: payment.invoice ? serializeInvoiceSummary(payment.invoice) : null };
  });
}
