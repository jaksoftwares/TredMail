import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@tredmail/db";
import { PLATFORM_ORG_SLUG } from "@tredmail/core/config/env";
import {
  adjustCredit,
  assignPayment,
  createManualInvoice,
  recordManualPayment,
  refundPayment,
  resumeSending,
  setSuspension,
  staffSetPlan,
  voidInvoice,
} from "@tredmail/core/billing/admin";
import { runBillingCycle } from "@tredmail/core/billing/cycle";
import { planPrice } from "@tredmail/core/billing/plans";
import {
  serializeBillingAccount,
  serializeEntitlements,
  serializeInvoice,
  serializeInvoiceSummary,
  serializePayment,
  serializePlan,
  serializeSubscription,
  serializeUsage,
} from "@tredmail/core/billing/serialize";
import { reconcilePendingPayments } from "@tredmail/core/billing/service";
import { ensureBillingAccount, getEntitlements } from "@tredmail/core/billing/subscriptions";
import { usageSummary } from "@tredmail/core/billing/usage";
import { requireStaff } from "../middleware/auth.js";

type Failure = { ok: false; statusCode: number; error: string; message: string };
const send = (reply: FastifyReply, result: { ok: true } | Failure, body: unknown = { ok: true }) =>
  result.ok ? reply.send(body) : reply.status(result.statusCode).send({ statusCode: result.statusCode, error: result.error, message: result.message });
const bad = (reply: FastifyReply, details: unknown) => reply.status(400).send({ statusCode: 400, error: "validation_error", message: "Invalid request.", details });

const intervalSchema = z.enum(["month", "year"]).transform((v) => (v === "year" ? "YEAR" : "MONTH") as "MONTH" | "YEAR");
const optionalInt = z.number().int().min(0).nullable().optional();

const planInputSchema = z.object({
  plan: z.string().min(1),
  interval: intervalSchema.default("month"),
  custom_price: optionalInt,
  custom_monthly_emails: optionalInt,
  custom_daily_emails: optionalInt,
  custom_max_domains: optionalInt,
  custom_max_members: optionalInt,
  restart_period: z.boolean().default(true),
});

const planEditSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  price_monthly: z.number().int().min(0).optional(),
  price_yearly: z.number().int().min(0).nullable().optional(),
  monthly_emails: z.number().int().min(0).optional(),
  daily_emails: z.number().int().min(0).optional(),
  overage_price_per_1000: z.number().int().min(0).nullable().optional(),
  overage_limit: z.number().int().min(0).nullable().optional(),
  max_domains: z.number().int().min(0).optional(),
  max_members: z.number().int().min(0).optional(),
  log_retention_days: z.number().int().min(1).max(395).optional(),
  features: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  is_public: z.boolean().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

const startOfMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** The back-office for TredMail staff: workspaces, plans, invoices and payments. */
export async function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireStaff);
  const staffId = (request: { sessionUser?: { id: string } }) => request.sessionUser!.id;

  // GET /v1/admin/overview - Revenue and account health at a glance
  fastify.get("/overview", async () => {
    const [subscriptions, collected, open, unmatched, paused, suspended, workspaces] = await Promise.all([
      prisma.subscription.findMany({ include: { plan: true }, where: { organization: { slug: { not: PLATFORM_ORG_SLUG } } } }),
      prisma.payment.groupBy({
        by: ["currency"],
        where: { status: "SUCCEEDED", gateway: { not: "credit" }, completedAt: { gte: startOfMonth() } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.invoice.findMany({ where: { status: "OPEN" }, select: { total: true, amountPaid: true, currency: true, dueAt: true } }),
      prisma.payment.count({ where: { organizationId: null, status: "SUCCEEDED" } }),
      prisma.organization.count({ where: { sendingPausedAt: { not: null } } }),
      prisma.organization.count({ where: { suspendedAt: { not: null } } }),
      prisma.organization.count({ where: { slug: { not: PLATFORM_ORG_SLUG } } }),
    ]);
    const byPlan: Record<string, number> = {};
    const mrr: Record<string, number> = {};
    let paying = 0;
    let pastDue = 0;
    for (const s of subscriptions) {
      byPlan[s.planId] = (byPlan[s.planId] ?? 0) + 1;
      if (s.status === "PAST_DUE") pastDue++;
      const price = s.customPrice ?? planPrice(s.plan, s.interval) ?? 0;
      if (price > 0) {
        paying++;
        mrr[s.plan.currency] = (mrr[s.plan.currency] ?? 0) + Math.round(s.interval === "YEAR" ? price / 12 : price);
      }
    }
    const outstanding: Record<string, number> = {};
    const overdue: Record<string, number> = {};
    for (const i of open) {
      outstanding[i.currency] = (outstanding[i.currency] ?? 0) + i.total - i.amountPaid;
      if (i.dueAt < new Date()) overdue[i.currency] = (overdue[i.currency] ?? 0) + i.total - i.amountPaid;
    }
    return {
      workspaces,
      paying_workspaces: paying,
      by_plan: byPlan,
      mrr,
      collected_this_month: Object.fromEntries(collected.map((c) => [c.currency, c._sum.amount ?? 0])),
      payments_this_month: collected.reduce((n, c) => n + c._count, 0),
      outstanding,
      overdue,
      past_due_workspaces: pastDue,
      unmatched_payments: unmatched,
      paused_workspaces: paused,
      suspended_workspaces: suspended,
    };
  });

  // GET /v1/admin/workspaces?q=&plan=&status=&cursor=
  fastify.get<{ Querystring: { q?: string; plan?: string; status?: string; cursor?: string } }>("/workspaces", async (request) => {
    const { q, plan, status, cursor } = request.query;
    const where: Prisma.OrganizationWhereInput = {
      slug: { not: PLATFORM_ORG_SLUG },
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { slug: { contains: q, mode: "insensitive" } },
              { id: q },
              { members: { some: { user: { email: { contains: q.toLowerCase() } } } } },
              { billingAccount: { accountCode: q.toUpperCase() } },
            ],
          }
        : {}),
      ...(plan ? { subscription: { planId: plan } } : {}),
      ...(status === "suspended" ? { suspendedAt: { not: null } } : {}),
      ...(status === "paused" ? { sendingPausedAt: { not: null } } : {}),
      ...(status === "past_due" ? { subscription: { status: "PAST_DUE" } } : {}),
    };
    const orgs = await prisma.organization.findMany({
      where,
      include: {
        subscription: { include: { plan: true } },
        billingAccount: { select: { accountCode: true, creditBalance: true } },
        members: { where: { role: "OWNER" }, take: 1, include: { user: { select: { email: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = orgs.slice(0, 50);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const usage = await prisma.usageDaily.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: page.map((o) => o.id) }, day: { gte: since } },
      _sum: { emails: true },
    });
    const usageByOrg = new Map(usage.map((u) => [u.organizationId, u._sum.emails ?? 0]));
    return {
      data: page.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        owner_email: o.members[0]?.user.email ?? null,
        plan: o.subscription?.planId ?? "free",
        plan_name: o.subscription?.plan.name ?? "Free",
        interval: o.subscription?.interval.toLowerCase() ?? "month",
        billing_status: o.subscription?.status.toLowerCase() ?? "active",
        account_code: o.billingAccount?.accountCode ?? null,
        emails_30d: usageByOrg.get(o.id) ?? 0,
        suspended: Boolean(o.suspendedAt),
        sending_paused: Boolean(o.sendingPausedAt),
        is_commercial: o.isCommercial,
        created_at: o.createdAt.toISOString(),
      })),
      next_cursor: orgs.length > 50 ? page[page.length - 1].id : null,
    };
  });

  // GET /v1/admin/workspaces/:id
  fastify.get<{ Params: { id: string } }>("/workspaces/:id", async (request, reply) => {
    const org = await prisma.organization.findUnique({
      where: { id: request.params.id },
      include: { members: { include: { user: { select: { email: true, name: true } } }, orderBy: { createdAt: "asc" } } },
    });
    if (!org) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Workspace not found." });
    const [{ subscription, entitlements }, usage, account, invoices, payments, audit, domains] = await Promise.all([
      getEntitlements(org.id),
      usageSummary(org.id),
      ensureBillingAccount(org.id),
      prisma.invoice.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.payment.findMany({ where: { organizationId: org.id }, include: { invoice: { select: { number: true } } }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.auditLog.findMany({
        where: { organizationId: org.id, OR: [{ action: { startsWith: "billing." } }, { action: { startsWith: "workspace." } }] },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.domain.findMany({ where: { organizationId: org.id }, select: { name: true, status: true } }),
    ]);
    const pendingPlan = subscription.pendingPlanId ? await prisma.plan.findUnique({ where: { id: subscription.pendingPlanId } }) : null;
    return {
      workspace: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        website: org.website,
        use_case: org.useCase,
        is_commercial: org.isCommercial,
        created_at: org.createdAt.toISOString(),
        suspended_at: org.suspendedAt?.toISOString() ?? null,
        suspended_reason: org.suspendedReason,
        sending_paused_at: org.sendingPausedAt?.toISOString() ?? null,
        sending_pause_reason: org.sendingPauseReason,
      },
      members: org.members.map((m) => ({ email: m.user.email, name: m.user.name, role: m.role })),
      domains: domains.map((d) => ({ name: d.name, status: d.status.toLowerCase() })),
      subscription: serializeSubscription(subscription, pendingPlan),
      entitlements: serializeEntitlements(entitlements),
      usage: serializeUsage(usage),
      account: serializeBillingAccount(account),
      invoices: invoices.map(serializeInvoiceSummary),
      payments: payments.map((p) => serializePayment(p, { staff: true })),
      audit: audit.map((a) => ({ action: a.action, actor_type: a.actorType, metadata: a.metadata, created_at: a.createdAt.toISOString() })),
    };
  });

  // POST /v1/admin/workspaces/:id/plan - Set plan and custom terms without charging
  fastify.post<{ Params: { id: string } }>("/workspaces/:id/plan", async (request, reply) => {
    const parsed = planInputSchema.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.errors);
    const d = parsed.data;
    const result = await staffSetPlan(
      request.params.id,
      {
        planId: d.plan,
        interval: d.interval,
        customPrice: d.custom_price,
        customMonthlyEmails: d.custom_monthly_emails,
        customDailyEmails: d.custom_daily_emails,
        customMaxDomains: d.custom_max_domains,
        customMaxMembers: d.custom_max_members,
        restartPeriod: d.restart_period,
      },
      staffId(request),
    );
    return send(reply, result);
  });

  // POST /v1/admin/workspaces/:id/suspend | /unsuspend | /resume-sending
  fastify.post<{ Params: { id: string } }>("/workspaces/:id/suspend", async (request, reply) => {
    const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.errors);
    return send(reply, await setSuspension(request.params.id, true, parsed.data.reason, staffId(request)));
  });
  fastify.post<{ Params: { id: string } }>("/workspaces/:id/unsuspend", async (request, reply) =>
    send(reply, await setSuspension(request.params.id, false, null, staffId(request))),
  );
  fastify.post<{ Params: { id: string } }>("/workspaces/:id/resume-sending", async (request, reply) =>
    send(reply, await resumeSending(request.params.id, staffId(request))),
  );

  // POST /v1/admin/workspaces/:id/credit - Add (or remove, negative) account credit
  fastify.post<{ Params: { id: string } }>("/workspaces/:id/credit", async (request, reply) => {
    const parsed = z.object({ amount: z.number().int().refine((n) => n !== 0), reason: z.string().trim().min(3).max(300) }).safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.errors);
    return send(reply, await adjustCredit(request.params.id, parsed.data.amount, parsed.data.reason, staffId(request)));
  });

  // POST /v1/admin/workspaces/:id/invoices - Raise an invoice by hand
  fastify.post<{ Params: { id: string } }>("/workspaces/:id/invoices", async (request, reply) => {
    const parsed = z
      .object({
        currency: z.string().length(3).toUpperCase().default("KES"),
        due_days: z.number().int().min(0).max(90).default(14),
        notes: z.string().trim().max(1000).optional(),
        lines: z.array(z.object({ description: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).default(1), unit_amount: z.number().int() })).min(1).max(20),
      })
      .safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.errors);
    const d = parsed.data;
    const result = await createManualInvoice(
      request.params.id,
      { currency: d.currency, dueDays: d.due_days, notes: d.notes, lines: d.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitAmount: l.unit_amount })) },
      staffId(request),
    );
    return result.ok ? reply.status(201).send(serializeInvoiceSummary(result.invoice)) : send(reply, result);
  });

  // GET /v1/admin/invoices/:id
  fastify.get<{ Params: { id: string } }>("/invoices/:id", async (request, reply) => {
    const invoice = await prisma.invoice.findUnique({ where: { id: request.params.id }, include: { lines: true, payments: true, organization: { select: { name: true } } } });
    if (!invoice) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Invoice not found." });
    return { ...serializeInvoice(invoice, { staff: true }), workspace: { id: invoice.organizationId, name: invoice.organization.name } };
  });

  // POST /v1/admin/invoices/:id/void
  fastify.post<{ Params: { id: string } }>("/invoices/:id/void", async (request, reply) =>
    send(reply, await voidInvoice(request.params.id, { staffId: staffId(request) })),
  );

  // GET /v1/admin/payments?status=&unmatched=true&q=
  fastify.get<{ Querystring: { status?: string; unmatched?: string; q?: string } }>("/payments", async (request) => {
    const { status, unmatched, q } = request.query;
    const upper = status?.toUpperCase();
    const payments = await prisma.payment.findMany({
      where: {
        gateway: { not: "credit" },
        ...(upper === "PENDING" || upper === "SUCCEEDED" || upper === "FAILED" || upper === "REFUNDED" ? { status: upper } : {}),
        ...(unmatched === "true" ? { organizationId: null, status: "SUCCEEDED" } : {}),
        ...(q ? { OR: [{ providerReceipt: { contains: q.toUpperCase() } }, { accountReference: { contains: q, mode: "insensitive" } }, { payerPhone: { contains: q } }] } : {}),
      },
      include: { invoice: { select: { number: true } }, organization: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { data: payments.map((p) => ({ ...serializePayment(p, { staff: true }), workspace_name: p.organization?.name ?? null })) };
  });

  // POST /v1/admin/payments - Record a bank transfer, cheque or cash payment
  fastify.post("/payments", async (request, reply) => {
    const parsed = z
      .object({
        organization_id: z.string().min(1),
        invoice_id: z.string().min(1).nullable().optional(),
        amount: z.number().int().positive(),
        currency: z.string().length(3).toUpperCase().default("KES"),
        method: z.enum(["bank_transfer", "cash", "cheque", "mpesa_paybill", "other"]),
        reference: z.string().trim().min(2).max(80),
        note: z.string().trim().max(300).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.errors);
    const d = parsed.data;
    const result = await recordManualPayment(
      { organizationId: d.organization_id, invoiceId: d.invoice_id, amount: d.amount, currency: d.currency, method: d.method, reference: d.reference, note: d.note },
      staffId(request),
    );
    return result.ok ? reply.status(201).send(serializePayment(result.payment, { staff: true })) : send(reply, result);
  });

  // POST /v1/admin/payments/:id/assign - Attach an unmatched payment to a workspace
  fastify.post<{ Params: { id: string } }>("/payments/:id/assign", async (request, reply) => {
    const parsed = z.object({ organization_id: z.string().min(1), invoice_id: z.string().min(1).nullable().optional() }).safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.errors);
    return send(reply, await assignPayment(request.params.id, parsed.data.organization_id, parsed.data.invoice_id ?? null, staffId(request)));
  });

  // POST /v1/admin/payments/:id/refund - Record a refund made in the provider's portal
  fastify.post<{ Params: { id: string } }>("/payments/:id/refund", async (request, reply) => {
    const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.errors);
    return send(reply, await refundPayment(request.params.id, parsed.data.reason, staffId(request)));
  });

  // GET /v1/admin/plans | POST /v1/admin/plans | PATCH /v1/admin/plans/:id
  fastify.get("/plans", async () => {
    const [plans, counts] = await Promise.all([
      prisma.plan.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.subscription.groupBy({ by: ["planId"], _count: true }),
    ]);
    const used = new Map(counts.map((c) => [c.planId, c._count]));
    return { data: plans.map((p) => ({ ...serializePlan(p), is_public: p.isPublic, is_active: p.isActive, sort_order: p.sortOrder, workspaces: used.get(p.id) ?? 0 })) };
  });

  const planData = (d: z.infer<typeof planEditSchema>): Prisma.PlanUpdateInput => ({
    name: d.name,
    description: d.description,
    priceMonthly: d.price_monthly,
    priceYearly: d.price_yearly,
    monthlyEmails: d.monthly_emails,
    dailyEmails: d.daily_emails,
    overagePricePer1000: d.overage_price_per_1000,
    overageLimit: d.overage_limit,
    maxDomains: d.max_domains,
    maxMembers: d.max_members,
    logRetentionDays: d.log_retention_days,
    features: d.features,
    isPublic: d.is_public,
    isActive: d.is_active,
    sortOrder: d.sort_order,
  });

  fastify.post("/plans", async (request, reply) => {
    const parsed = planEditSchema.extend({ id: z.string().regex(/^[a-z0-9_-]{2,30}$/), name: z.string().trim().min(1).max(40), monthly_emails: z.number().int().min(0) }).safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.errors);
    const exists = await prisma.plan.findUnique({ where: { id: parsed.data.id } });
    if (exists) return reply.status(409).send({ statusCode: 409, error: "plan_exists", message: `A plan '${parsed.data.id}' already exists.` });
    const plan = await prisma.plan.create({ data: { ...(planData(parsed.data) as Prisma.PlanCreateInput), id: parsed.data.id, name: parsed.data.name, monthlyEmails: parsed.data.monthly_emails } });
    return reply.status(201).send(serializePlan(plan));
  });

  fastify.patch<{ Params: { id: string } }>("/plans/:id", async (request, reply) => {
    const parsed = planEditSchema.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.errors);
    const exists = await prisma.plan.findUnique({ where: { id: request.params.id } });
    if (!exists) return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Plan not found." });
    const plan = await prisma.plan.update({ where: { id: request.params.id }, data: planData(parsed.data) });
    return serializePlan(plan);
  });

  // GET /v1/admin/payment-callbacks - What gateways sent, newest first (troubleshooting)
  fastify.get<{ Querystring: { gateway?: string } }>("/payment-callbacks", async (request) => {
    const rows = await prisma.paymentCallback.findMany({
      where: request.query.gateway ? { gateway: request.query.gateway } : {},
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { data: rows.map((r) => ({ id: r.id, gateway: r.gateway, kind: r.kind, payload: r.payload, ip_address: r.ipAddress, outcome: r.outcome, created_at: r.createdAt.toISOString() })) };
  });

  // POST /v1/admin/billing/run - Run the billing cycle and payment reconciliation now
  fastify.post("/billing/run", async () => ({ cycle: await runBillingCycle(), reconcile: await reconcilePendingPayments() }));
}
