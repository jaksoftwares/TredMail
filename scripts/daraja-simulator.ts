/**
 * A local stand-in for Safaricom's Daraja API, for development and the billing tests.
 *
 *   npm run payments:simulator            (listens on http://localhost:4010)
 *
 * Point the API at it with MPESA_BASE_URL=http://localhost:4010 and any MPESA_CONSUMER_KEY,
 * MPESA_CONSUMER_SECRET, MPESA_SHORTCODE (e.g. 174379) and MPESA_PASSKEY. It answers like
 * Daraja and calls TredMail back like Safaricom does. The phone number picks the outcome:
 *
 *   ...1032  the customer cancels the prompt        ...0001  not enough M-Pesa balance
 *   ...1037  the phone never answers (query: 1037)  ...9999  paid, but the callback is lost
 *   anything else: paid, callback after a couple of seconds
 *
 * Paybill payments: POST /simulate/paybill {"account":"INV2600001","amount":2500,"phone":"254712345678"}
 */
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

interface StkTransaction {
  checkoutRequestId: string;
  merchantRequestId: string;
  phone: string;
  amount: number;
  account: string;
  callbackUrl: string;
  outcome: { code: number; desc: string } | null; // null while the customer is "deciding"
  sendCallback: boolean;
}

export interface SimulatorOptions {
  port?: number;
  delayMs?: number;
  /** When set, STK passwords are checked against it like Daraja does */
  passkey?: string;
  log?: (line: string) => void;
}

export interface DarajaSimulator {
  url: string;
  transactions: Map<string, StkTransaction>;
  registered: { confirmationUrl?: string; validationUrl?: string; shortCode?: string };
  paybill(account: string, amount: number, phone?: string): Promise<{ transId: string; validation: unknown; confirmation: unknown }>;
  close(): Promise<void>;
}

const TOKEN = "sim_" + crypto.randomBytes(12).toString("hex");

function timestamp(): string {
  const eat = new Date(Date.now() + 3 * 3600_000);
  return eat.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function receipt(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  return "TK" + Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, body: String(err) };
  }
}

export function startDarajaSimulator(options: SimulatorOptions = {}): Promise<DarajaSimulator> {
  const delayMs = options.delayMs ?? 2000;
  const log = options.log ?? ((line: string) => console.log(`[daraja-sim] ${line}`));
  const transactions = new Map<string, StkTransaction>();
  const registered: DarajaSimulator["registered"] = {};

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const finish = (tx: StkTransaction) => {
    const phone = tx.phone;
    if (phone.endsWith("1032")) tx.outcome = { code: 1032, desc: "Request cancelled by user" };
    else if (phone.endsWith("0001")) tx.outcome = { code: 1, desc: "The balance is insufficient for the transaction" };
    else if (phone.endsWith("1037")) tx.outcome = { code: 1037, desc: "DS timeout user cannot be reached" };
    else tx.outcome = { code: 0, desc: "The service request is processed successfully." };
    if (!tx.sendCallback) return;
    const callback =
      tx.outcome.code === 0
        ? {
            Body: {
              stkCallback: {
                MerchantRequestID: tx.merchantRequestId,
                CheckoutRequestID: tx.checkoutRequestId,
                ResultCode: 0,
                ResultDesc: tx.outcome.desc,
                CallbackMetadata: {
                  Item: [
                    { Name: "Amount", Value: tx.amount },
                    { Name: "MpesaReceiptNumber", Value: receipt() },
                    { Name: "Balance" },
                    { Name: "TransactionDate", Value: Number(timestamp()) },
                    { Name: "PhoneNumber", Value: Number(tx.phone) },
                  ],
                },
              },
            },
          }
        : { Body: { stkCallback: { MerchantRequestID: tx.merchantRequestId, CheckoutRequestID: tx.checkoutRequestId, ResultCode: tx.outcome.code, ResultDesc: tx.outcome.desc } } };
    void post(tx.callbackUrl, callback).then((r) => log(`STK callback ${tx.checkoutRequestId} (result ${tx.outcome!.code}) -> HTTP ${r.status}`));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const bearer = req.headers.authorization === `Bearer ${TOKEN}`;

    if (req.method === "GET" && url.pathname === "/oauth/v1/generate") {
      if (!req.headers.authorization?.startsWith("Basic ")) return send(res, 400, { errorCode: "400.008.01", errorMessage: "Invalid Authentication passed" });
      return send(res, 200, { access_token: TOKEN, expires_in: "3599" });
    }
    if (req.method !== "POST") return send(res, 404, { errorMessage: "Not found" });
    const body = await readJson(req);

    if (url.pathname === "/simulate/paybill") {
      const result = await simulator.paybill(String(body.account ?? ""), Number(body.amount ?? 0), body.phone ? String(body.phone) : undefined);
      return send(res, 200, result);
    }
    if (!bearer) return send(res, 401, { errorCode: "404.001.03", errorMessage: "Invalid Access Token" });

    if (url.pathname === "/mpesa/stkpush/v1/processrequest") {
      const phone = String(body.PhoneNumber ?? "");
      if (!/^254[17]\d{8}$/.test(phone)) return send(res, 400, { requestId: crypto.randomUUID(), errorCode: "400.002.02", errorMessage: "Bad Request - Invalid PhoneNumber" });
      if (options.passkey) {
        const expected = Buffer.from(`${body.BusinessShortCode}${options.passkey}${body.Timestamp}`).toString("base64");
        if (body.Password !== expected) return send(res, 400, { requestId: crypto.randomUUID(), errorCode: "400.002.02", errorMessage: "Bad Request - Invalid Password" });
      }
      if (!Number.isInteger(body.Amount) || Number(body.Amount) < 1) return send(res, 400, { requestId: crypto.randomUUID(), errorCode: "400.002.02", errorMessage: "Bad Request - Invalid Amount" });
      const tx: StkTransaction = {
        checkoutRequestId: `ws_CO_${timestamp()}${crypto.randomBytes(5).toString("hex")}`,
        merchantRequestId: `${crypto.randomInt(10000, 99999)}-${crypto.randomInt(1e6, 9e6)}-1`,
        phone,
        amount: Number(body.Amount),
        account: String(body.AccountReference ?? ""),
        callbackUrl: String(body.CallBackURL ?? ""),
        outcome: null,
        sendCallback: !phone.endsWith("9999") && !phone.endsWith("1037"),
      };
      transactions.set(tx.checkoutRequestId, tx);
      log(`STK push KES ${tx.amount} to ${phone} for ${tx.account} (${tx.checkoutRequestId})`);
      setTimeout(() => finish(tx), delayMs);
      return send(res, 200, {
        MerchantRequestID: tx.merchantRequestId,
        CheckoutRequestID: tx.checkoutRequestId,
        ResponseCode: "0",
        ResponseDescription: "Success. Request accepted for processing",
        CustomerMessage: "Success. Request accepted for processing",
      });
    }

    if (url.pathname === "/mpesa/stkpushquery/v1/query") {
      const tx = transactions.get(String(body.CheckoutRequestID ?? ""));
      if (!tx) return send(res, 500, { requestId: crypto.randomUUID(), errorCode: "500.001.1001", errorMessage: "The transaction is being processed" });
      if (!tx.outcome) return send(res, 500, { requestId: crypto.randomUUID(), errorCode: "500.001.1001", errorMessage: "The transaction is being processed" });
      return send(res, 200, {
        ResponseCode: "0",
        ResponseDescription: "The service request has been accepted successsfully",
        MerchantRequestID: tx.merchantRequestId,
        CheckoutRequestID: tx.checkoutRequestId,
        ResultCode: String(tx.outcome.code),
        ResultDesc: tx.outcome.desc,
      });
    }

    if (url.pathname === "/mpesa/c2b/v1/registerurl" || url.pathname === "/mpesa/c2b/v2/registerurl") {
      const urls = [String(body.ConfirmationURL ?? ""), String(body.ValidationURL ?? "")];
      if (urls.some((u) => /m-?pesa|safaricom/i.test(u))) {
        return send(res, 400, { errorCode: "400.003.02", errorMessage: "Bad Request - Invalid URL: URLs must not contain M-Pesa or Safaricom" });
      }
      registered.shortCode = String(body.ShortCode ?? "");
      registered.confirmationUrl = urls[0];
      registered.validationUrl = urls[1];
      log(`C2B URLs registered for ${registered.shortCode}`);
      return send(res, 200, { OriginatorCoversationID: crypto.randomUUID(), ResponseCode: "0", ResponseDescription: "Success" });
    }

    return send(res, 404, { errorMessage: "Not found" });
  });

  const simulator: DarajaSimulator = {
    url: "",
    transactions,
    registered,
    async paybill(account, amount, phone = "254708374149") {
      const transId = receipt();
      const payload = {
        TransactionType: "Pay Bill",
        TransID: transId,
        TransTime: timestamp(),
        TransAmount: amount.toFixed(2),
        BusinessShortCode: registered.shortCode ?? "600000",
        BillRefNumber: account,
        InvoiceNumber: "",
        OrgAccountBalance: "",
        ThirdPartyTransID: "",
        MSISDN: phone,
        FirstName: "Test",
        MiddleName: "",
        LastName: "Payer",
      };
      const validation = registered.validationUrl ? await post(registered.validationUrl, payload) : null;
      const rejected = (validation?.body as { ResultCode?: string } | null)?.ResultCode && (validation!.body as { ResultCode: string }).ResultCode !== "0";
      const confirmation = !rejected && registered.confirmationUrl ? await post(registered.confirmationUrl, payload) : null;
      log(`Paybill KES ${amount} account ${account}: ${rejected ? "rejected by validation" : `confirmation HTTP ${confirmation?.status}`}`);
      return { transId, validation: validation?.body ?? null, confirmation: confirmation?.body ?? null };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  return new Promise((resolve) => {
    server.listen(options.port ?? 4010, () => {
      const address = server.address();
      simulator.url = `http://localhost:${typeof address === "object" && address ? address.port : options.port}`;
      resolve(simulator);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.DARAJA_SIMULATOR_PORT ?? 4010);
  startDarajaSimulator({ port, passkey: process.env.MPESA_PASSKEY }).then((sim) => {
    console.log(`Daraja simulator on ${sim.url}. Set MPESA_BASE_URL=${sim.url} for the API and worker.`);
  });
}
