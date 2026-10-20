import { describe, expect, it } from "vitest";
import { formatMoney, roundForCurrency, taxOn } from "../src/billing/money.js";
import { addInterval, addMonths, closedWindows, hourIn, remainingFraction, usageWindowAt, utcDay } from "../src/billing/periods.js";
import { classifyChange, hardEmailLimit, overageCharge } from "../src/billing/plans.js";
import { computeTotals, normalizeReference } from "../src/billing/invoices.js";
import { maskPhone, normalizeKenyanPhone } from "../src/billing/gateways/phone.js";
import { darajaTimestamp, MpesaGateway, parseDarajaTimestamp, stkPassword, type MpesaConfig } from "../src/billing/gateways/mpesa.js";
import { breakerDecision } from "../src/services/circuit-breaker.js";
import { generateAccountCode } from "../src/billing/subscriptions.js";

const d = (iso: string) => new Date(iso);

describe("billing periods", () => {
  it("adds months without spilling into the next month", () => {
    expect(addMonths(d("2026-01-31T00:00:00Z"), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(addMonths(d("2028-01-31T00:00:00Z"), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(addMonths(d("2026-10-20T00:00:00Z"), 3).toISOString()).toBe("2027-01-20T00:00:00.000Z");
    expect(addInterval(d("2026-10-20T00:00:00Z"), "YEAR").toISOString()).toBe("2027-10-20T00:00:00.000Z");
  });

  it("splits a yearly period into monthly usage windows", () => {
    const start = d("2026-01-15T00:00:00Z");
    const end = addInterval(start, "YEAR");
    expect(usageWindowAt(start, end, d("2026-03-20T10:00:00Z"))).toEqual({ start: d("2026-03-15T00:00:00Z"), end: d("2026-04-15T00:00:00Z") });
    expect(usageWindowAt(start, addInterval(start, "MONTH"), d("2026-01-20T00:00:00Z"))).toEqual({ start, end: d("2026-02-15T00:00:00Z") });
    const closed = closedWindows(start, end, start, d("2026-04-01T00:00:00Z"));
    expect(closed.map((w) => w.end.toISOString().slice(0, 10))).toEqual(["2026-02-15", "2026-03-15"]);
    expect(closedWindows(start, end, d("2026-02-15T00:00:00Z"), d("2026-04-01T00:00:00Z"))).toHaveLength(1);
  });

  it("computes the unused share of a period and the day key", () => {
    expect(remainingFraction(d("2026-10-01T00:00:00Z"), d("2026-10-31T00:00:00Z"), d("2026-10-16T00:00:00Z"))).toBeCloseTo(0.5);
    expect(remainingFraction(d("2026-10-01T00:00:00Z"), d("2026-10-31T00:00:00Z"), d("2026-11-16T00:00:00Z"))).toBe(0);
    expect(utcDay(d("2026-10-20T23:59:59Z")).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(hourIn("Africa/Nairobi", d("2026-10-20T05:00:00Z"))).toBe(8);
  });
});

describe("money and invoice totals", () => {
  it("rounds mobile-money currencies to whole units", () => {
    expect(roundForCurrency(250_049, "KES")).toBe(250_000);
    expect(roundForCurrency(250_050, "KES")).toBe(250_100);
    expect(roundForCurrency(1_999, "USD")).toBe(1_999);
    expect(formatMoney(250_000, "KES")).toBe("KES 2,500");
    expect(formatMoney(1_999, "USD")).toBe("USD 19.99");
    expect(taxOn(250_000, 1600, "KES")).toBe(40_000);
  });

  it("totals lines with credits and tax, never below zero", () => {
    const totals = computeTotals(
      [
        { kind: "plan", description: "Scale", unitAmount: 1_150_000 },
        { kind: "credit", description: "Unused Pro", unitAmount: -125_000 },
      ],
      "KES",
      1600,
    );
    expect(totals.subtotal).toBe(1_025_000);
    expect(totals.tax).toBe(164_000);
    expect(totals.total).toBe(1_189_000);
    expect(computeTotals([{ kind: "credit", description: "x", unitAmount: -500 }], "KES", 0).total).toBe(0);
    expect(computeTotals([{ kind: "overage", description: "x", quantity: 3, unitAmount: 12_000 }], "KES", 0).total).toBe(36_000);
  });

  it("normalizes references typed by payers", () => {
    expect(normalizeReference(" inv-26 00001 ")).toBe("INV2600001");
    expect(generateAccountCode()).toMatch(/^TM[ACDEFGHJKMNPQRTUVWXY34679]{6}$/);
  });
});

describe("plans", () => {
  const pro = { monthlyEmails: 50_000, overagePricePer1000: 12_000, overageLimit: 100_000 };
  it("caps sending at the allowance plus the overage limit", () => {
    expect(hardEmailLimit({ monthlyEmails: 3000, overagePricePer1000: null, overageLimit: null })).toBe(3000);
    expect(hardEmailLimit(pro)).toBe(150_000);
    expect(hardEmailLimit({ ...pro, overageLimit: null })).toBe(Infinity);
    expect(hardEmailLimit({ monthlyEmails: 0, overagePricePer1000: null, overageLimit: null })).toBe(Infinity);
  });

  it("bills started blocks of 1,000 extra emails", () => {
    expect(overageCharge(50_000, pro).amount).toBe(0);
    expect(overageCharge(50_001, pro)).toEqual({ extraEmails: 1, blocks: 1, amount: 12_000 });
    expect(overageCharge(52_500, pro)).toEqual({ extraEmails: 2500, blocks: 3, amount: 36_000 });
    expect(overageCharge(9_000, { monthlyEmails: 3000, overagePricePer1000: null }).amount).toBe(0);
  });

  it("treats bigger plans and yearly billing as upgrades", () => {
    const free = { id: "free", sortOrder: 0 };
    const proPlan = { id: "pro", sortOrder: 10 };
    const scale = { id: "scale", sortOrder: 20 };
    expect(classifyChange({ plan: free, interval: "MONTH" }, { plan: proPlan, interval: "MONTH" })).toBe("upgrade");
    expect(classifyChange({ plan: scale, interval: "MONTH" }, { plan: proPlan, interval: "YEAR" })).toBe("downgrade");
    expect(classifyChange({ plan: proPlan, interval: "MONTH" }, { plan: proPlan, interval: "YEAR" })).toBe("upgrade");
    expect(classifyChange({ plan: proPlan, interval: "YEAR" }, { plan: proPlan, interval: "MONTH" })).toBe("downgrade");
    expect(classifyChange({ plan: proPlan, interval: "YEAR" }, { plan: proPlan, interval: "YEAR" })).toBe("none");
  });
});

describe("Kenyan phone numbers", () => {
  it("accepts the usual ways of writing a number", () => {
    for (const input of ["0712345678", "0712 345 678", "+254712345678", "254712345678", "712345678", "+254 (712) 345-678"]) {
      expect(normalizeKenyanPhone(input)).toBe("254712345678");
    }
    expect(normalizeKenyanPhone("0110345678")).toBe("254110345678");
    expect(normalizeKenyanPhone("0812345678")).toBeNull();
    expect(normalizeKenyanPhone("07123")).toBeNull();
    expect(normalizeKenyanPhone("abc")).toBeNull();
    expect(maskPhone("254712345678")).toBe("0712 *** 678");
  });
});

describe("M-Pesa gateway", () => {
  const config: MpesaConfig = {
    baseUrl: "https://daraja.test",
    consumerKey: "key",
    consumerSecret: "secret",
    shortcode: "174379",
    passkey: "pk",
    transactionType: "CustomerPayBillOnline",
    paybillNumber: "174379",
    verifyCallbacks: true,
    allowedIps: [],
  };

  function fakeDaraja(handlers: Record<string, (body: Record<string, unknown>) => { status?: number; body: unknown }>) {
    const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ path: url.pathname, body, auth });
      if (url.pathname === "/oauth/v1/generate") return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }));
      const handler = handlers[url.pathname];
      if (!handler) return new Response("{}", { status: 404 });
      const result = handler(body);
      return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
    }) as typeof fetch;
    return { calls, gateway: new MpesaGateway(config, (kind) => `https://api.example/v1/payments/callbacks/mobile/${kind}/secret`, fetchImpl) };
  }

  it("builds Daraja timestamps and passwords", () => {
    expect(darajaTimestamp(d("2026-10-20T11:05:09Z"))).toBe("20261020140509");
    expect(parseDarajaTimestamp("20261020140509")?.toISOString()).toBe("2026-10-20T11:05:09.000Z");
    expect(stkPassword("174379", "pk", "20261020140509")).toBe(Buffer.from("174379pk20261020140509").toString("base64"));
  });

  it("sends an STK push for whole shillings with the invoice number as reference", async () => {
    const { calls, gateway } = fakeDaraja({
      "/mpesa/stkpush/v1/processrequest": () => ({ body: { ResponseCode: "0", CheckoutRequestID: "ws_CO_1", MerchantRequestID: "m1" } }),
    });
    const result = await gateway.initiate({ paymentId: "p1", amount: 250_000, currency: "KES", reference: "INV2600001", description: "TredMail subscription", payer: { phone: "254712345678" } });
    expect(result).toMatchObject({ status: "pending", providerReference: "ws_CO_1", nextAction: { type: "await_customer" } });
    const push = calls.find((c) => c.path === "/mpesa/stkpush/v1/processrequest")!;
    expect(push.auth).toBe("Bearer tok");
    expect(push.body).toMatchObject({ BusinessShortCode: "174379", Amount: 2500, PartyA: "254712345678", PartyB: "174379", AccountReference: "INV2600001", TransactionType: "CustomerPayBillOnline" });
    expect(String(push.body.TransactionDesc).length).toBeLessThanOrEqual(13);
    expect(push.body.CallBackURL).toBe("https://api.example/v1/payments/callbacks/mobile/stk/secret");
    expect(push.body.Password).toBe(stkPassword("174379", "pk", String(push.body.Timestamp)));
  });

  it("reports a refused push as failed", async () => {
    const { gateway } = fakeDaraja({
      "/mpesa/stkpush/v1/processrequest": () => ({ status: 400, body: { errorCode: "400.002.02", errorMessage: "Bad Request - Invalid PhoneNumber" } }),
    });
    const result = await gateway.initiate({ paymentId: "p1", amount: 100, currency: "KES", reference: "INV1", description: "x", payer: { phone: "254712345678" } });
    expect(result).toMatchObject({ status: "failed", code: "mpesa_400.002.02" });
  });

  const success = {
    Body: {
      stkCallback: {
        MerchantRequestID: "m1",
        CheckoutRequestID: "ws_CO_1",
        ResultCode: 0,
        ResultDesc: "ok",
        CallbackMetadata: { Item: [{ Name: "Amount", Value: 2500 }, { Name: "MpesaReceiptNumber", Value: "TJK1ABC2DE" }, { Name: "PhoneNumber", Value: 254712345678 }] },
      },
    },
  };

  it("accepts a success callback only when the query API confirms it", async () => {
    let queryResult: Record<string, unknown> = { ResultCode: "0", ResultDesc: "ok" };
    const { gateway } = fakeDaraja({ "/mpesa/stkpushquery/v1/query": () => ({ body: queryResult }) });
    const ok = await gateway.handleCallback({ kind: "stk", body: success, headers: {}, ip: "1.2.3.4" });
    expect(ok.updates).toEqual([expect.objectContaining({ providerReference: "ws_CO_1", status: "succeeded", receipt: "TJK1ABC2DE", amount: 250_000, payerPhone: "254712345678" })]);
    expect(ok.reply().body).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });

    queryResult = { ResultCode: "1032", ResultDesc: "cancelled" };
    const spoofed = await gateway.handleCallback({ kind: "stk", body: success, headers: {}, ip: "1.2.3.4" });
    expect(spoofed.updates).toEqual([expect.objectContaining({ status: "failed", code: "mpesa_1032" })]);

    queryResult = { errorCode: "500.001.1001", errorMessage: "The transaction is being processed" };
    const unsure = await gateway.handleCallback({ kind: "stk", body: success, headers: {}, ip: "1.2.3.4" });
    expect(unsure.updates).toBeUndefined();
  });

  it("maps failure callbacks to readable reasons", async () => {
    const { gateway } = fakeDaraja({});
    const result = await gateway.handleCallback({
      kind: "stk",
      body: { Body: { stkCallback: { CheckoutRequestID: "ws_CO_2", ResultCode: 1032, ResultDesc: "Request cancelled by user" } } },
      headers: {},
      ip: "1.2.3.4",
    });
    expect(result.updates?.[0]).toMatchObject({ status: "failed", code: "mpesa_1032", message: "The payment was cancelled on the phone." });
  });

  it("parses Paybill confirmations and answers validations", async () => {
    const { gateway } = fakeDaraja({});
    const body = { TransID: "TJK9XYZ", TransTime: "20261020140509", TransAmount: "2500.00", BillRefNumber: "inv2600001", MSISDN: "254712345678", FirstName: "Jane", LastName: "Doe" };
    const confirm = await gateway.handleCallback({ kind: "confirm", body, headers: {}, ip: "1.2.3.4" });
    expect(confirm.incoming).toEqual([expect.objectContaining({ receipt: "TJK9XYZ", amount: 250_000, accountReference: "inv2600001", payerName: "Jane Doe", method: "mpesa_paybill" })]);
    expect(confirm.incoming?.[0].paidAt.toISOString()).toBe("2026-10-20T11:05:09.000Z");

    const validate = await gateway.handleCallback({ kind: "validate", body, headers: {}, ip: "1.2.3.4" });
    expect(validate.validation).toEqual({ accountReference: "inv2600001", amount: 250_000 });
    expect(validate.reply({ accept: false }).body).toEqual({ ResultCode: "C2B00012", ResultDesc: "Rejected" });
    expect(validate.reply({ accept: true }).body).toEqual({ ResultCode: "0", ResultDesc: "Accepted" });
  });

  it("gives Paybill instructions and checks the callback allowlist", () => {
    const { gateway } = fakeDaraja({});
    const offline = gateway.offlineInstructions("INV2600001", 250_000, "KES");
    expect(offline?.fields).toEqual([
      { label: "Business number", value: "174379" },
      { label: "Account number", value: "INV2600001" },
      { label: "Amount", value: "KES 2,500" },
    ]);
    expect(gateway.acceptsCallbackFrom("10.0.0.1")).toBe(true);
    const locked = new MpesaGateway({ ...config, allowedIps: ["196.201.214.200"] }, () => "");
    expect(locked.acceptsCallbackFrom("::ffff:196.201.214.200")).toBe(true);
    expect(locked.acceptsCallbackFrom("10.0.0.1")).toBe(false);
  });
});

describe("circuit breaker", () => {
  it("pauses on high hard-bounce or complaint rates, with enough volume", () => {
    expect(breakerDecision({ delivered: 90, hardBounced: 10, complained: 0 })).toMatch(/hard-bounced/);
    expect(breakerDecision({ delivered: 20, hardBounced: 10, complained: 0 })).toBeNull(); // too few to judge
    expect(breakerDecision({ delivered: 1000, hardBounced: 10, complained: 0 })).toBeNull();
    expect(breakerDecision({ delivered: 1000, hardBounced: 0, complained: 3 })).toMatch(/spam/);
    expect(breakerDecision({ delivered: 1000, hardBounced: 0, complained: 2 })).toBeNull();
    expect(breakerDecision({ delivered: 10_000, hardBounced: 0, complained: 5 })).toBeNull();
  });
});
