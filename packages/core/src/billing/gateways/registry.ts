import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { DARAJA_URLS, MpesaGateway } from "./mpesa.js";
import type { PaymentGateway } from "./types.js";

/** Payments staff record by hand: bank transfers, cheques, cash. */
class ManualGateway implements PaymentGateway {
  readonly id: string = "manual";
  readonly name: string = "Bank transfer or other";
  readonly method: string = "bank_transfer";
  readonly currencies = ["KES", "USD", "EUR", "GBP"] as const;
  readonly staffOnly = true;
  readonly payerFields: PaymentGateway["payerFields"] = [];
  isConfigured() {
    return true;
  }
  normalizePayer() {
    return { ok: true as const, payer: {} };
  }
}

/** Balance already held for the workspace, used like a payment. */
class AccountCreditGateway extends ManualGateway {
  override readonly id = "credit";
  override readonly name = "Account credit";
  override readonly method = "account_credit";
}

/** Secret path segment that proves a callback came through a URL TredMail handed out. */
export function callbackToken(gatewayId: string): string {
  return crypto.createHmac("sha256", env.TREDMAIL_MASTER_ENCRYPTION_KEY).update(`payments-callback:${gatewayId}`).digest("hex").slice(0, 40);
}

export function callbackBaseUrl(): string {
  const base = env.MPESA_CALLBACK_BASE_URL ?? new URL(env.API_BASE_URL).origin;
  return base.replace(/\/+$/, "");
}

export function callbackUrl(gateway: Pick<PaymentGateway, "id" | "callbackSlug">, kind: string): string {
  return `${callbackBaseUrl()}/v1/payments/callbacks/${gateway.callbackSlug ?? gateway.id}/${kind}/${callbackToken(gateway.id)}`;
}

let gateways: Map<string, PaymentGateway> | null = null;

function build(): Map<string, PaymentGateway> {
  const list: PaymentGateway[] = [new ManualGateway(), new AccountCreditGateway()];
  const mpesa = new MpesaGateway(
    {
      baseUrl: env.MPESA_BASE_URL ?? DARAJA_URLS[env.MPESA_ENVIRONMENT],
      consumerKey: env.MPESA_CONSUMER_KEY ?? "",
      consumerSecret: env.MPESA_CONSUMER_SECRET ?? "",
      shortcode: env.MPESA_SHORTCODE ?? "",
      passkey: env.MPESA_PASSKEY ?? "",
      transactionType: env.MPESA_TRANSACTION_TYPE,
      tillNumber: env.MPESA_TILL_NUMBER,
      paybillNumber: env.MPESA_PAYBILL_NUMBER ?? (env.MPESA_TRANSACTION_TYPE === "CustomerPayBillOnline" ? env.MPESA_SHORTCODE : undefined),
      verifyCallbacks: env.MPESA_VERIFY_CALLBACKS,
      allowedIps: (env.MPESA_ALLOWED_IPS ?? "").split(",").map((ip) => ip.trim()).filter(Boolean),
    },
    (kind) => callbackUrl({ id: "mpesa", callbackSlug: "mobile" }, kind),
  );
  if (mpesa.isConfigured()) list.push(mpesa);
  return new Map(list.map((g) => [g.id, g]));
}

function registry(): Map<string, PaymentGateway> {
  gateways ??= build();
  return gateways;
}

/** Adds or replaces a gateway (new providers, tests). */
export function registerGateway(gateway: PaymentGateway): void {
  registry().set(gateway.id, gateway);
}

export function getGateway(id: string): PaymentGateway | undefined {
  return registry().get(id);
}

export function gatewayByCallbackSlug(slug: string): PaymentGateway | undefined {
  return [...registry().values()].find((g) => (g.callbackSlug ?? g.id) === slug && g.handleCallback);
}

/** Gateways a customer can pay an invoice in `currency` with, in registration order. */
export function customerGateways(currency: string): PaymentGateway[] {
  return [...registry().values()].filter((g) => !g.staffOnly && g.isConfigured() && g.initiate && g.currencies.includes(currency));
}

export function allGateways(): PaymentGateway[] {
  return [...registry().values()];
}
