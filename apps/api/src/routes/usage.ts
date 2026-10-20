import type { FastifyInstance } from "fastify";
import { listPlans } from "@tredmail/core/billing/service";
import { serializeEntitlements, serializePlan, serializeUsage } from "@tredmail/core/billing/serialize";
import { usageSummary } from "@tredmail/core/billing/usage";
import { authenticate, requireScope } from "../middleware/auth.js";

export async function usageRoutes(fastify: FastifyInstance) {
  // GET /v1/usage - This month's usage and the plan's limits (API key or console)
  fastify.get("/usage", { preHandler: [authenticate, requireScope("stats:read")] }, async (request) => {
    const summary = await usageSummary(request.organization!.id);
    return { ...serializeUsage(summary), plan: serializeEntitlements(summary.entitlements) };
  });
}

/** Public price list, for the pricing page. No key needed. */
export async function planRoutes(fastify: FastifyInstance) {
  // GET /v1/plans
  fastify.get("/plans", async () => ({ data: (await listPlans()).map(serializePlan) }));
}
