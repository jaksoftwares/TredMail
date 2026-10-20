/**
 * The contract between TredMail billing and a payment provider. Billing only ever talks to
 * this interface: invoices, subscriptions and receipts work the same whichever gateway took
 * the money. Adding a provider (card processor, another mobile-money network, bank API)
 * means implementing this interface and registering it in registry.ts.
 *
 * Amounts are integers in minor units (cents), as everywhere in billing.
 */

/** A field the customer fills in to pay, e.g. their M-Pesa phone number. */
export interface PayerField {
  name: string;
  label: string;
  placeholder?: string;
  hint?: string;
  type: "tel" | "text" | "email";
}

export interface InitiatePaymentRequest {
  /** TredMail's payment id; gateways may pass it on as their own reference */
  paymentId: string;
  amount: number;
  currency: string;
  /** What the payer sees as the reference, normally the invoice number */
  reference: string;
  description: string;
  /** Normalized payer fields (from normalizePayer) */
  payer: Record<string, string>;
}

export type NextAction =
  /** The customer approves on their device (M-Pesa PIN prompt); poll the payment status */
  | { type: "await_customer"; message: string }
  /** The customer completes payment on the provider's page (card checkouts) */
  | { type: "redirect"; url: string };

export type InitiatePaymentResult =
  | { status: "pending"; providerReference: string; nextAction: NextAction; raw?: unknown }
  | { status: "succeeded"; providerReference: string; receipt?: string; raw?: unknown }
  | { status: "failed"; code: string; message: string; raw?: unknown };

/** The outcome of a payment TredMail started, learned from a callback or a status query. */
export interface PaymentUpdate {
  providerReference: string;
  status: "pending" | "succeeded" | "failed";
  receipt?: string;
  /** Amount actually paid, when the gateway reports it */
  amount?: number;
  code?: string;
  message?: string;
  payerPhone?: string;
  payerName?: string;
  raw?: unknown;
}

/** Money the customer sent on their own initiative, e.g. a Paybill payment. */
export interface IncomingPayment {
  receipt: string;
  method: string;
  amount: number;
  currency: string;
  /** What the payer typed as the account number: an invoice number or account code */
  accountReference: string;
  payerPhone?: string;
  payerName?: string;
  paidAt: Date;
  raw?: unknown;
}

export interface CallbackInput {
  /** Path segment chosen by the gateway, e.g. "stk", "validate", "confirm" */
  kind: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}

export interface CallbackResult {
  updates?: PaymentUpdate[];
  incoming?: IncomingPayment[];
  /** The gateway asks TredMail whether to accept a payment before it completes */
  validation?: { accountReference: string; amount: number };
  /** Builds the HTTP reply the provider expects, given billing's decision on `validation` */
  reply(decision?: { accept: boolean }): { status: number; body: unknown };
}

/** How to pay without a prompt (e.g. Paybill), shown on invoices and in emails. */
export interface OfflineInstructions {
  title: string;
  steps: string[];
  fields: Array<{ label: string; value: string }>;
}

export interface PaymentGateway {
  /** Stable id stored on payments, e.g. "mpesa" */
  readonly id: string;
  /** Shown to customers, e.g. "M-Pesa" */
  readonly name: string;
  readonly currencies: readonly string[];
  /** Payment method recorded for payments this gateway starts, e.g. "mpesa_stk" */
  readonly method: string;
  /** Only staff can record payments through it (bank transfers, cheques) */
  readonly staffOnly?: boolean;
  /**
   * Path segment of this gateway's callback URLs. Must not contain the provider's brand
   * where the provider forbids it (Safaricom rejects URLs containing "mpesa").
   */
  readonly callbackSlug?: string;
  readonly payerFields: readonly PayerField[];

  isConfigured(): boolean;
  normalizePayer(input: Record<string, unknown>): { ok: true; payer: Record<string, string> } | { ok: false; message: string };
  initiate?(request: InitiatePaymentRequest): Promise<InitiatePaymentResult>;
  /** Asks the provider for the current status of a payment it is processing */
  query?(providerReference: string): Promise<PaymentUpdate>;
  handleCallback?(input: CallbackInput): Promise<CallbackResult>;
  /** False when the callback's source address is not on the provider's allowlist */
  acceptsCallbackFrom?(ip: string): boolean;
  offlineInstructions?(reference: string, amount: number, currency: string): OfflineInstructions | null;
  /** One-time provider setup (registering callback URLs); returns lines to print */
  setup?(): Promise<string[]>;
}

/** Thrown by gateways when the provider cannot be reached or answers unexpectedly. */
export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly code = "gateway_error",
  ) {
    super(message);
  }
}
