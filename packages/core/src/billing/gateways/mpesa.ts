import { maskPhone, normalizeKenyanPhone } from "./phone.js";
import {
  GatewayError,
  type CallbackInput,
  type CallbackResult,
  type IncomingPayment,
  type InitiatePaymentRequest,
  type InitiatePaymentResult,
  type OfflineInstructions,
  type PaymentGateway,
  type PaymentUpdate,
} from "./types.js";

/**
 * M-Pesa through Safaricom's Daraja API.
 *
 * - M-Pesa Express (STK push): TredMail sends a PIN prompt to the customer's phone; the
 *   result arrives on the "stk" callback, and the query API covers missed callbacks.
 * - Paybill (C2B): customers pay by hand with the invoice number (or their account code) as
 *   the account number; Safaricom calls "validate" (only when external validation is enabled
 *   for the short code) and "confirm". URLs are registered once with `npm run payments:setup`.
 *
 * Daraja does not sign callbacks. TredMail puts a secret token in each callback URL, can
 * restrict source IPs (MPESA_ALLOWED_IPS), and by default confirms every success it is told
 * about with the query API before accepting it.
 */

export interface MpesaConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  transactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
  tillNumber?: string;
  paybillNumber?: string;
  verifyCallbacks: boolean;
  allowedIps: string[];
}

export const DARAJA_URLS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
} as const;

type Fetch = typeof fetch;

/** Daraja timestamps are Kenyan time (UTC+3, no daylight saving): YYYYMMDDHHmmss. */
export function darajaTimestamp(at = new Date()): string {
  const eat = new Date(at.getTime() + 3 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${eat.getUTCFullYear()}${pad(eat.getUTCMonth() + 1)}${pad(eat.getUTCDate())}${pad(eat.getUTCHours())}${pad(eat.getUTCMinutes())}${pad(eat.getUTCSeconds())}`;
}

/** Parses a Daraja timestamp (Kenyan time) such as 20261020143015. */
export function parseDarajaTimestamp(value: unknown): Date | null {
  const text = String(value ?? "");
  const m = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 3, mi, s));
}

export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

const RESULT_MESSAGES: Record<string, string> = {
  "1": "The M-Pesa balance was not enough for this payment.",
  "1001": "Another M-Pesa transaction is in progress on this phone. Wait a minute and try again.",
  "1019": "The payment request expired before it was completed.",
  "1025": "M-Pesa could not send the payment prompt. Try again.",
  "1032": "The payment was cancelled on the phone.",
  "1037": "The phone did not respond in time (it may be off or out of network).",
  "2001": "The M-Pesa PIN entered was wrong.",
  "9999": "M-Pesa could not send the payment prompt. Try again.",
};

export function describeResult(code: string, fallback?: string): string {
  return RESULT_MESSAGES[code] ?? fallback ?? `M-Pesa returned result ${code}.`;
}

const toCents = (major: unknown) => Math.round(Number(major) * 100);

const ACCEPTED = { ResultCode: 0, ResultDesc: "Accepted" };

export class MpesaGateway implements PaymentGateway {
  readonly id = "mpesa";
  readonly name = "M-Pesa";
  readonly method = "mpesa_stk";
  readonly currencies = ["KES"] as const;
  readonly callbackSlug = "mobile";
  readonly payerFields = [
    {
      name: "phone",
      label: "M-Pesa phone number",
      placeholder: "0712 345 678",
      hint: "You will get a prompt on this phone to enter your M-Pesa PIN.",
      type: "tel" as const,
    },
  ];

  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: MpesaConfig,
    private readonly callbackUrl: (kind: string) => string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  isConfigured(): boolean {
    const c = this.config;
    return Boolean(c.consumerKey && c.consumerSecret && c.shortcode && c.passkey);
  }

  normalizePayer(input: Record<string, unknown>) {
    const phone = normalizeKenyanPhone(String(input.phone ?? ""));
    if (!phone) return { ok: false as const, message: "Enter a Safaricom number such as 0712 345 678." };
    return { ok: true as const, payer: { phone } };
  }

  acceptsCallbackFrom(ip: string): boolean {
    return this.config.allowedIps.length === 0 || this.config.allowedIps.includes(ip.replace(/^::ffff:/, ""));
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const basic = Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString("base64");
    const res = await this.request("/oauth/v1/generate?grant_type=client_credentials", { method: "GET", headers: { Authorization: `Basic ${basic}` } });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: string | number };
    if (!res.ok || !body.access_token) {
      throw new GatewayError(`M-Pesa sign-in failed (HTTP ${res.status}). Check MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET.`, "gateway_auth_failed");
    }
    const ttl = Math.max(60, Number(body.expires_in ?? 3599) - 60) * 1000;
    this.token = { value: body.access_token, expiresAt: Date.now() + ttl };
    return body.access_token;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, "")}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new GatewayError(`M-Pesa could not be reached: ${(err as Error).message}`, "gateway_unavailable");
    }
  }

  private async post(path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const token = await this.accessToken();
    const res = await this.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) this.token = null;
    return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  }

  async initiate(request: InitiatePaymentRequest): Promise<InitiatePaymentResult> {
    if (request.currency !== "KES") return { status: "failed", code: "unsupported_currency", message: "M-Pesa only accepts KES." };
    const amount = Math.ceil(request.amount / 100);
    if (amount < 1) return { status: "failed", code: "amount_too_small", message: "The amount is below KES 1." };
    const timestamp = darajaTimestamp();
    const { status, body } = await this.post("/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: this.config.shortcode,
      Password: stkPassword(this.config.shortcode, this.config.passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: this.config.transactionType,
      Amount: amount,
      PartyA: request.payer.phone,
      PartyB: this.config.transactionType === "CustomerBuyGoodsOnline" ? (this.config.tillNumber ?? this.config.shortcode) : this.config.shortcode,
      PhoneNumber: request.payer.phone,
      CallBackURL: this.callbackUrl("stk"),
      AccountReference: request.reference.slice(0, 12),
      TransactionDesc: request.description.slice(0, 13),
    });
    if (status === 200 && String(body.ResponseCode) === "0" && typeof body.CheckoutRequestID === "string") {
      return {
        status: "pending",
        providerReference: body.CheckoutRequestID,
        nextAction: { type: "await_customer", message: `Check ${maskPhone(request.payer.phone)} and enter your M-Pesa PIN to pay KES ${amount.toLocaleString("en-US")}.` },
        raw: body,
      };
    }
    const code = String(body.errorCode ?? body.ResponseCode ?? status);
    const message = String(body.errorMessage ?? body.ResponseDescription ?? "M-Pesa refused the payment request.");
    return { status: "failed", code: `mpesa_${code}`, message, raw: body };
  }

  async query(providerReference: string): Promise<PaymentUpdate> {
    const timestamp = darajaTimestamp();
    const { body } = await this.post("/mpesa/stkpushquery/v1/query", {
      BusinessShortCode: this.config.shortcode,
      Password: stkPassword(this.config.shortcode, this.config.passkey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: providerReference,
    });
    if (body.ResultCode === undefined || body.ResultCode === null) {
      // e.g. 500.001.1001 "The transaction is being processed": the customer has not answered yet
      return { providerReference, status: "pending", raw: body };
    }
    const code = String(body.ResultCode);
    if (code === "0") return { providerReference, status: "succeeded", raw: body };
    return { providerReference, status: "failed", code: `mpesa_${code}`, message: describeResult(code, body.ResultDesc as string | undefined), raw: body };
  }

  async handleCallback(input: CallbackInput): Promise<CallbackResult> {
    if (input.kind === "stk") return this.stkCallback(input.body);
    if (input.kind === "validate") {
      const body = (input.body ?? {}) as Record<string, unknown>;
      return {
        validation: { accountReference: String(body.BillRefNumber ?? ""), amount: toCents(body.TransAmount) },
        reply: (decision) =>
          decision?.accept === false
            ? { status: 200, body: { ResultCode: "C2B00012", ResultDesc: "Rejected" } }
            : { status: 200, body: { ResultCode: "0", ResultDesc: "Accepted" } },
      };
    }
    if (input.kind === "confirm") {
      const body = (input.body ?? {}) as Record<string, unknown>;
      const receipt = String(body.TransID ?? "");
      const incoming: IncomingPayment[] = receipt
        ? [
            {
              receipt,
              method: "mpesa_paybill",
              amount: toCents(body.TransAmount),
              currency: "KES",
              accountReference: String(body.BillRefNumber ?? ""),
              payerPhone: body.MSISDN ? String(body.MSISDN) : undefined,
              payerName: [body.FirstName, body.MiddleName, body.LastName].filter(Boolean).join(" ") || undefined,
              paidAt: parseDarajaTimestamp(body.TransTime) ?? new Date(),
              raw: body,
            },
          ]
        : [];
      return { incoming, reply: () => ({ status: 200, body: ACCEPTED }) };
    }
    return { reply: () => ({ status: 404, body: { ResultCode: 1, ResultDesc: "Unknown callback" } }) };
  }

  private async stkCallback(rawBody: unknown): Promise<CallbackResult> {
    const callback = ((rawBody as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback ?? null) as Record<string, unknown> | null;
    const reply = () => ({ status: 200, body: ACCEPTED });
    if (!callback || typeof callback.CheckoutRequestID !== "string") return { reply };

    const providerReference = callback.CheckoutRequestID;
    const code = String(callback.ResultCode);
    if (code !== "0") {
      return {
        updates: [{ providerReference, status: "failed", code: `mpesa_${code}`, message: describeResult(code, callback.ResultDesc as string | undefined), raw: rawBody }],
        reply,
      };
    }

    const items = ((callback.CallbackMetadata as { Item?: Array<{ Name: string; Value?: unknown }> })?.Item ?? []).reduce<Record<string, unknown>>(
      (acc, item) => ({ ...acc, [item.Name]: item.Value }),
      {},
    );
    const update: PaymentUpdate = {
      providerReference,
      status: "succeeded",
      receipt: items.MpesaReceiptNumber ? String(items.MpesaReceiptNumber) : undefined,
      amount: items.Amount !== undefined ? toCents(items.Amount) : undefined,
      payerPhone: items.PhoneNumber ? String(items.PhoneNumber) : undefined,
      raw: rawBody,
    };

    if (this.config.verifyCallbacks) {
      // Daraja callbacks are unsigned: accept a success only when the query API agrees.
      let confirmed: PaymentUpdate;
      try {
        confirmed = await this.query(providerReference);
      } catch {
        return { reply }; // the reconciler queries again shortly
      }
      if (confirmed.status === "pending") return { reply };
      if (confirmed.status === "failed") return { updates: [{ ...confirmed, raw: rawBody }], reply };
    }
    return { updates: [update], reply };
  }

  offlineInstructions(reference: string, amount: number, currency: string): OfflineInstructions | null {
    const paybill = this.config.paybillNumber;
    if (currency !== "KES") return null;
    const shillings = Math.ceil(amount / 100).toLocaleString("en-US");
    if (!paybill) {
      const till = this.config.transactionType === "CustomerBuyGoodsOnline" ? (this.config.tillNumber ?? this.config.shortcode) : null;
      if (!till) return null;
      // Buy Goods carries no account number, so these payments are matched by Dovepeak staff.
      return {
        title: "Pay with M-Pesa Buy Goods",
        steps: [
          "On your phone open M-PESA, then Lipa na M-PESA, then Buy Goods and Services.",
          `Enter till number ${till}.`,
          `Enter the amount, KES ${shillings}, and your PIN.`,
          `Email the M-Pesa confirmation message with invoice ${reference} to Dovepeak billing; the payment is applied within one business day.`,
        ],
        fields: [
          { label: "Till number", value: till },
          { label: "Invoice", value: reference },
          { label: "Amount", value: `KES ${shillings}` },
        ],
      };
    }
    return {
      title: "Pay with M-Pesa Paybill",
      steps: [
        "On your phone open M-PESA, then Lipa na M-PESA, then Pay Bill.",
        `Enter business number ${paybill}.`,
        `Enter account number ${reference}.`,
        `Enter the amount, KES ${shillings}, and your PIN.`,
        "The payment is applied automatically within a minute.",
      ],
      fields: [
        { label: "Business number", value: paybill },
        { label: "Account number", value: reference },
        { label: "Amount", value: `KES ${shillings}` },
      ],
    };
  }

  async setup(): Promise<string[]> {
    const lines: string[] = [];
    const shortcode = this.config.paybillNumber ?? (this.config.transactionType === "CustomerBuyGoodsOnline" ? this.config.shortcode : undefined);
    if (!shortcode) return ["M-Pesa: no Paybill or till short code, so manual payment (C2B) notifications are not registered."];
    const { status, body } = await this.post("/mpesa/c2b/v1/registerurl", {
      ShortCode: shortcode,
      ResponseType: "Completed",
      ConfirmationURL: this.callbackUrl("confirm"),
      ValidationURL: this.callbackUrl("validate"),
    });
    const ok = status === 200 && String(body.ResponseCode ?? body.ResponseDescription ?? "").match(/^0$|success/i);
    lines.push(
      ok
        ? `M-Pesa: Paybill ${shortcode} notifications registered.`
        : `M-Pesa: registering Paybill ${shortcode} failed (HTTP ${status}): ${String(body.errorMessage ?? body.ResponseDescription ?? JSON.stringify(body))}`,
    );
    lines.push(`  confirmation URL: ${this.callbackUrl("confirm").replace(/[^/]+$/, "<token>")}`);
    return lines;
  }
}
