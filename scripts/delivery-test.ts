/**
 * End-to-end test of the delivery engine (roadmap Phase 2) on a development machine.
 *
 * Needs: `docker compose --profile mta up -d` (Postgres, Redis, Mailpit, KumoMTA), and the
 * API and worker running with SMTP_HOST=localhost, SMTP_PORT=2525 and OPS_EMAIL set:
 *
 *   TREDMAIL_API_KEY=tred_live_... npm run test:delivery
 *
 * Proves that delivery status comes from KumoMTA's log, and that bounce reports, spam
 * complaints and postmaster mail sent back to KumoMTA's inbound port are handled.
 */
import assert from "node:assert/strict";
import nodemailer from "nodemailer";

const API_URL = (process.env.TREDMAIL_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const MAILPIT_URL = (process.env.MAILPIT_URL ?? "http://localhost:8035").replace(/\/+$/, "");
const MTA_INBOUND_PORT = Number(process.env.MTA_INBOUND_PORT ?? 2526);
const PRIMARY_DOMAIN = process.env.PRIMARY_DOMAIN ?? "tredmail.dovepeakdigital.com";
const FROM = process.env.DELIVERY_TEST_FROM ?? "TredMail Delivery Test <system@dovepeakdigital.com>";
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

async function waitFor<T>(label: string, check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const step = (message: string) => console.log(`- ${message}`);
const run = Date.now();

async function send(to: string, subject: string): Promise<string> {
  const res = await api("/v1/emails", {
    method: "POST",
    body: JSON.stringify({ from: FROM, to, subject, text: `Delivery test ${run}`, track_opens: false, track_clicks: false }),
  });
  assert.ok(res.status === 200 || res.status === 202, `send failed: ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

const emailStatus = (id: string) => async () => {
  const res = await api(`/v1/emails/${id}`);
  return res.body;
};

const waitForStatus = (id: string, status: string) =>
  waitFor(`email ${id} to become ${status}`, async () => {
    const email = await emailStatus(id)();
    return email.status === status.toLowerCase() ? email : undefined;
  });

/** The VERP envelope sender KumoMTA used, as Mailpit recorded it (Return-Path). */
async function returnPathOf(subject: string): Promise<string> {
  return waitFor(`Mailpit message "${subject}"`, async () => {
    const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`).then((r) => r.json() as Promise<Json>);
    const summary = search.messages?.[0];
    if (!summary) return undefined;
    const headers = (await fetch(`${MAILPIT_URL}/api/v1/message/${summary.ID}/headers`).then((r) => r.json())) as Json;
    return String(headers["Return-Path"]?.[0] ?? "").replace(/[<>]/g, "") || undefined;
  });
}

const inbound = nodemailer.createTransport({ host: "localhost", port: MTA_INBOUND_PORT, secure: false, ignoreTLS: true });

async function deliverInbound(envelopeFrom: string, envelopeTo: string, raw: string) {
  await inbound.sendMail({ envelope: { from: envelopeFrom, to: [envelopeTo] }, raw });
}

function dsn(to: string, failedRecipient: string, status: string, diagnostic: string) {
  const boundary = `dsn-${run}`;
  return [
    "From: Mail Delivery Subsystem <mailer-daemon@example.com>",
    `To: ${to}`,
    "Subject: Delivery Status Notification (Failure)",
    "MIME-Version: 1.0",
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain",
    "",
    "Your message could not be delivered.",
    `--${boundary}`,
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.example.com",
    "",
    `Final-Recipient: rfc822; ${failedRecipient}`,
    "Action: failed",
    `Status: ${status}`,
    `Diagnostic-Code: smtp; ${diagnostic}`,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function arf(emailId: string, recipient: string) {
  const boundary = `arf-${run}`;
  return [
    "From: Feedback Loop <fbl@example.com>",
    `To: fbl@${PRIMARY_DOMAIN}`,
    "Subject: Complaint about message",
    "MIME-Version: 1.0",
    `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain",
    "",
    "This is an email abuse report.",
    `--${boundary}`,
    "Content-Type: message/feedback-report",
    "",
    "Feedback-Type: abuse",
    "User-Agent: ExampleFBL/1.0",
    "Version: 1",
    `Original-Rcpt-To: ${recipient}`,
    "",
    `--${boundary}`,
    "Content-Type: text/rfc822-headers",
    "",
    `From: ${FROM}`,
    `To: ${recipient}`,
    `X-TredMail-ID: ${emailId}`,
    "Subject: Complaint target",
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function suppressed(address: string): Promise<Json | undefined> {
  const res = await api(`/v1/suppressions?email=${encodeURIComponent(address)}`);
  const list = (res.body.data ?? res.body.suppressions ?? []) as Json[];
  return list.find((s) => s.email === address);
}

async function main() {
  const ready = await fetch(`${API_URL}/health/ready`);
  assert.equal(ready.status, 200, "API is not ready");
  step("API ready");

  // 1. Delivery status comes from KumoMTA's delivery log
  const deliveredTo = `delivered-${run}@example.com`;
  const deliveredId = await send(deliveredTo, `Delivered ${run}`);
  const delivered = await waitForStatus(deliveredId, "DELIVERED");
  assert.ok(delivered.delivered_at, "delivered_at is set");
  const verp = await returnPathOf(`Delivered ${run}`);
  assert.match(verp, new RegExp(`^b-${deliveredId}-[0-9a-f]{16}@bounces\\.`), "envelope sender is a signed VERP address");
  step(`DELIVERED from KumoMTA's log, envelope ${verp}`);

  // 2. Asynchronous bounce report to the VERP address: bounced and suppressed
  const bouncedTo = `unknown-${run}@example.com`;
  const bouncedId = await send(bouncedTo, `Bounce ${run}`);
  await waitForStatus(bouncedId, "DELIVERED");
  const bounceVerp = await returnPathOf(`Bounce ${run}`);
  await deliverInbound("", bounceVerp, dsn(bounceVerp, bouncedTo, "5.1.1", "550 5.1.1 The email account that you tried to reach does not exist."));
  await waitForStatus(bouncedId, "BOUNCED");
  assert.ok(await waitFor("suppression", () => suppressed(bouncedTo)), "hard bounce suppresses the recipient");
  step("DSN to the VERP address: BOUNCED and recipient suppressed");

  // 3. A reputation block bounces but must not suppress a valid recipient
  const blockedTo = `blocked-${run}@example.com`;
  const blockedId = await send(blockedTo, `Blocked ${run}`);
  await waitForStatus(blockedId, "DELIVERED");
  const blockedVerp = await returnPathOf(`Blocked ${run}`);
  await deliverInbound("", blockedVerp, dsn(blockedVerp, blockedTo, "5.7.1", "550 5.7.1 Message rejected due to sender IP reputation (listed on Spamhaus)"));
  await waitForStatus(blockedId, "BOUNCED");
  assert.equal(await suppressed(blockedTo), undefined, "a reputation block must not suppress the recipient");
  step("policy block: BOUNCED (soft), recipient not suppressed");

  // 4. A forged bounce (bad signature) is ignored
  const forged = bounceVerp.replace(/-[0-9a-f]{16}@/, "-0000000000000000@");
  const victimTo = `victim-${run}@example.com`;
  const victimId = await send(victimTo, `Victim ${run}`);
  await waitForStatus(victimId, "DELIVERED");
  await deliverInbound("", forged.replace(bouncedId, victimId), dsn(forged, victimTo, "5.1.1", "550 5.1.1 User unknown"));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal((await emailStatus(victimId)()).status, "delivered", "a forged VERP bounce is ignored");
  step("forged bounce address: ignored");

  // 5. Spam complaint (ARF) to the feedback-loop address: complained and suppressed
  const complainerTo = `complainer-${run}@example.com`;
  const complainedId = await send(complainerTo, `Complaint ${run}`);
  await waitForStatus(complainedId, "DELIVERED");
  await deliverInbound("fbl@example.com", `fbl@${PRIMARY_DOMAIN}`, arf(complainedId, complainerTo));
  await waitForStatus(complainedId, "COMPLAINED");
  assert.ok(await waitFor("complaint suppression", () => suppressed(complainerTo)), "complaint suppresses the recipient");
  step("ARF complaint: COMPLAINED and recipient suppressed");

  // 6. Ordinary mail to postmaster@ is forwarded to OPS_EMAIL
  const postmasterSubject = `Postmaster ${run}`;
  await deliverInbound(
    "someone@example.org",
    `postmaster@${PRIMARY_DOMAIN}`,
    `From: someone@example.org\r\nTo: postmaster@${PRIMARY_DOMAIN}\r\nSubject: ${postmasterSubject}\r\n\r\nHello postmaster.\r\n`,
  );
  await waitFor("forwarded postmaster mail in Mailpit", async () => {
    const search = (await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"[TredMail inbound] ${postmasterSubject}"`)}`).then((r) => r.json())) as Json;
    return search.messages?.length ? true : undefined;
  });
  step("postmaster@ mail forwarded to OPS_EMAIL");

  // 7. The public port is not an open relay: mail for other domains is refused
  const relayAttempt = await deliverInbound(
    "spammer@example.org",
    "victim@gmail.com",
    "From: spammer@example.org\r\nTo: victim@gmail.com\r\nSubject: relay test\r\n\r\nx\r\n",
  ).then(
    () => "accepted",
    (err: Error & { responseCode?: number }) => `refused ${err.responseCode ?? ""}`,
  );
  assert.match(relayAttempt, /^refused/, "the public SMTP port must not relay to other domains");
  step(`relay to an outside domain: ${relayAttempt.trim()}`);

  inbound.close();
  console.log("\nDelivery engine test passed.");
}

main().catch((err) => {
  console.error(`\nDelivery engine test failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
