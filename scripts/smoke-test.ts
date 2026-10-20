/**
 * Local end-to-end smoke test. Needs the dev stack (docker compose up -d), the API and the worker.
 *
 *   TREDMAIL_API_KEY=tred_live_... npm run test:smoke
 *
 * Sends an email through the API, waits for the worker to hand it to Mailpit, then checks the
 * message is DKIM-signed and that the signed open pixel and click link are accepted, while a
 * tampered link is rejected.
 */
import assert from "node:assert/strict";

const API_URL = (process.env.TREDMAIL_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const MAILPIT_URL = (process.env.MAILPIT_URL ?? "http://localhost:8035").replace(/\/+$/, "");
const FROM = process.env.SMOKE_FROM ?? "TredMail Smoke Test <system@dovepeak.com>";
const API_KEY = process.env.TREDMAIL_API_KEY;

if (!API_KEY) {
  console.error("Set TREDMAIL_API_KEY to a key with full_access (run `npm run db:seed` to create one).");
  process.exit(1);
}

type Json = Record<string, any>;

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, ...init.headers },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

async function waitFor<T>(label: string, check: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function step(message: string) {
  console.log(`- ${message}`);
}

async function main() {
  const ready = await fetch(`${API_URL}/health/ready`);
  assert.equal(ready.status, 200, "API is not ready (is Postgres/Redis up?)");
  step("API ready");

  const unauthenticated = await fetch(`${API_URL}/v1/domains`);
  assert.equal(unauthenticated.status, 401, "unauthenticated request must be rejected");
  step("unauthenticated requests rejected");

  const marker = `smoke-${Date.now()}`;
  const send = await api("/v1/emails", {
    method: "POST",
    body: JSON.stringify({
      from: FROM,
      to: "smoke-test@example.com",
      subject: `TredMail smoke test ${marker}`,
      html: `<html><body><p>${marker}</p><p><a href="https://dovepeak.com/?ref=${marker}">Open</a></p></body></html>`,
      text: marker,
    }),
  });
  assert.equal(send.status, 200, `send failed: ${JSON.stringify(send.body)}`);
  const emailId: string = send.body.id;
  step(`email accepted (${emailId})`);

  const sent = await waitFor("worker to send", async () => {
    const res = await api(`/v1/emails/${emailId}`);
    if (res.body.status === "failed") throw new Error(`worker failed: ${res.body.smtp_response}`);
    return res.body.status === "sent" ? res.body : undefined;
  });
  assert.ok(sent.events.some((e: Json) => e.type === "sent"), "SENT event recorded");
  step("worker handed the email to the SMTP relay");

  const message = await waitFor("Mailpit to receive the email", async () => {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"${marker}"`)}`);
    const found = ((await res.json()) as Json).messages?.[0];
    return found ? ((await (await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`)).json()) as Json) : undefined;
  });
  const headers = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}/headers`)).json()) as Json;
  assert.ok(headers["Dkim-Signature"]?.[0]?.includes("d=dovepeak.com"), "message is DKIM-signed for dovepeak.com");
  assert.equal(headers["List-Unsubscribe"], undefined, "transactional mail has no broken List-Unsubscribe header");
  step("Mailpit received a DKIM-signed message");

  const html: string = message.HTML;
  const pixel = html.match(/<img src="([^"]+\/open\/[^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  const click = html.match(/href="([^"]+\/click\/[^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(pixel?.includes("sig="), "open pixel is signed");
  assert.ok(click?.includes("sig="), "click link is signed");

  const pixelRes = await fetch(pixel!);
  assert.equal(pixelRes.headers.get("content-type"), "image/gif");

  const clickRes = await fetch(click!, { redirect: "manual" });
  assert.equal(clickRes.status, 302, "signed click redirects");
  assert.equal(clickRes.headers.get("location"), `https://dovepeak.com/?ref=${marker}`);

  const tampered = click!.replace(/url=[^&]+/, `url=${encodeURIComponent("https://evil.example/")}`);
  assert.equal((await fetch(tampered, { redirect: "manual" })).status, 400, "tampered click link is rejected");
  step("signed tracking accepted, tampered link rejected");

  await waitFor("open and click events", async () => {
    const res = await api(`/v1/emails/${emailId}`);
    const types = res.body.events.map((e: Json) => e.type);
    return types.includes("opened") && types.includes("clicked") ? true : undefined;
  });
  step("open and click events recorded");

  const stats = await api("/v1/stats");
  assert.equal(stats.status, 200);
  step(`stats: ${stats.body.metrics.acceptedCount} accepted, ${stats.body.metrics.uniqueOpens} opened`);

  console.log("\nSmoke test passed.");
}

main().catch((err) => {
  console.error(`\nSmoke test failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
