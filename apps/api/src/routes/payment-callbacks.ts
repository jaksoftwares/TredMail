import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@tredmail/db";
import { callbackToken, gatewayByCallbackSlug } from "@tredmail/core/billing/gateways/registry";
import { applyPaymentUpdate, recordIncomingPayment, validateIncomingPayment } from "@tredmail/core/billing/service";

const sameToken = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Notifications from payment gateways: POST /v1/payments/callbacks/:slug/:kind/:token.
 * The token is a per-gateway secret derived from the master key, so only URLs TredMail gave
 * the provider are accepted. Every callback is stored (payment_callbacks) before it is
 * processed, and processing is idempotent, so provider retries are harmless.
 */
export async function paymentCallbackRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { slug: string; kind: string; token: string } }>("/v1/payments/callbacks/:slug/:kind/:token", async (request, reply) => {
    const gateway = gatewayByCallbackSlug(request.params.slug);
    if (!gateway?.handleCallback || !sameToken(request.params.token, callbackToken(gateway.id))) {
      return reply.status(404).send({ statusCode: 404, error: "not_found", message: "Not found." });
    }
    if (gateway.acceptsCallbackFrom && !gateway.acceptsCallbackFrom(request.ip)) {
      request.log.warn({ ip: request.ip, gateway: gateway.id }, "payment callback from an address not on the allowlist");
      return reply.status(403).send({ statusCode: 403, error: "forbidden", message: "Forbidden." });
    }

    const kind = request.params.kind;
    const log = await prisma.paymentCallback.create({
      data: { gateway: gateway.id, kind, payload: (request.body ?? {}) as Prisma.InputJsonValue, ipAddress: request.ip },
    });

    try {
      const result = await gateway.handleCallback({ kind, body: request.body, headers: request.headers, ip: request.ip });
      const outcomes: string[] = [];
      let decision: { accept: boolean } | undefined;
      if (result.validation) {
        decision = { accept: await validateIncomingPayment(result.validation.accountReference) };
        outcomes.push(decision.accept ? "validation accepted" : `validation rejected (${result.validation.accountReference})`);
      }
      for (const update of result.updates ?? []) {
        outcomes.push(`${update.providerReference}: ${await applyPaymentUpdate(gateway.id, update)}`);
      }
      for (const incoming of result.incoming ?? []) {
        outcomes.push(`${incoming.receipt}: ${await recordIncomingPayment(gateway.id, incoming)}`);
      }
      await prisma.paymentCallback.update({ where: { id: log.id }, data: { outcome: outcomes.join("; ") || "ignored" } });
      const response = result.reply(decision);
      return reply.status(response.status).send(response.body);
    } catch (err) {
      request.log.error({ err, gateway: gateway.id, kind }, "payment callback failed");
      await prisma.paymentCallback.update({ where: { id: log.id }, data: { outcome: `error: ${(err as Error).message}`.slice(0, 500) } }).catch(() => undefined);
      // A non-2xx reply makes the provider retry later; the reconciler also catches up.
      return reply.status(500).send({ ResultCode: 1, ResultDesc: "Temporary error, retry" });
    }
  });
}
