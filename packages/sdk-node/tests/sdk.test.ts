import { describe, expect, it } from "vitest";
import { signWebhookPayload, generateWebhookSecret } from "@tredmail/core/webhooks/dispatcher";
import { TredMail, WebhookVerificationError, toSendRequest, verifyWebhook } from "../src/index.js";

describe("Node SDK", () => {
  it("verifies signatures made by TredMail and rejects tampering and stale timestamps", () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ type: "email.delivered", created_at: "2026-10-20T12:00:00Z", data: { email_id: "e1" } });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { "webhook-id": "msg_1", "webhook-timestamp": String(timestamp), "webhook-signature": signWebhookPayload(secret, "msg_1", timestamp, body) };

    expect(verifyWebhook({ secret, headers, body }).data).toEqual({ email_id: "e1" });
    expect(verifyWebhook({ secret, headers: new Headers(headers), body: Buffer.from(body) }).type).toBe("email.delivered");
    expect(() => verifyWebhook({ secret, headers, body: body.replace("e1", "e2") })).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook({ secret: generateWebhookSecret(), headers, body })).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook({ secret, headers, body, now: new Date((timestamp + 600) * 1000) })).toThrow(/too old/);
  });

  it("maps camelCase options to the API body", () => {
    const at = new Date("2026-11-01T09:00:00Z");
    expect(
      toSendRequest({ to: "a@b.c", replyTo: "r@b.c", scheduledAt: at, trackOpens: false, attachments: [{ filename: "a.txt", content: Buffer.from("hi"), contentId: "x" }] }),
    ).toMatchObject({ to: "a@b.c", reply_to: "r@b.c", scheduled_at: "2026-11-01T09:00:00.000Z", track_opens: false, attachments: [{ filename: "a.txt", content: "aGk=", content_id: "x" }] });
  });

  it("sends the key and idempotency header and returns { data, error }", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith("/emails")
        ? new Response(JSON.stringify({ id: "e1", status: "queued" }), { status: 200 })
        : new Response(JSON.stringify({ statusCode: 404, error: "not_found", message: "Email 'x' not found." }), { status: 404 });
    }) as unknown as typeof fetch;
    const client = new TredMail({ apiKey: "tred_live_x", baseUrl: "https://api.test/v1/", fetch: fakeFetch });

    const sent = await client.emails.send({ to: "a@b.c", subject: "s", text: "t" }, { idempotencyKey: "order-1" });
    expect(sent).toEqual({ data: { id: "e1", status: "queued" }, error: null });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://api.test/v1/emails");
    expect(headers.Authorization).toBe("Bearer tred_live_x");
    expect(headers["Idempotency-Key"]).toBe("order-1");

    const missing = await client.emails.get("x");
    expect(missing.data).toBeNull();
    expect(missing.error).toMatchObject({ statusCode: 404, error: "not_found" });

    const list = await client.emails.list({ status: ["bounced", "failed"], limit: 5 });
    expect(list.error?.statusCode).toBe(404);
    expect(calls[2].url).toBe("https://api.test/v1/emails?status=bounced%2Cfailed&limit=5");
  });

  it("reads usage and the price list", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.endsWith("/plans") ? { data: [{ id: "pro" }] } : { emails_sent: 12, remaining: 2988 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new TredMail({ apiKey: "tred_live_x", baseUrl: "https://api.test/v1", fetch: fakeFetch });
    expect((await client.usage.get()).data?.remaining).toBe(2988);
    expect((await client.plans.list()).data?.data[0].id).toBe("pro");
    expect(urls).toEqual(["https://api.test/v1/usage", "https://api.test/v1/plans"]);
  });
});
