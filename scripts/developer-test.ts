/**
 * End-to-end test of the developer product (roadmap Phase 3) on a development machine.
 *
 * Needs `docker compose --profile mta up -d` and, from the repository root, the API, worker
 * and SMTP relay running against KumoMTA with private webhook targets allowed:
 *
 *   SMTP_HOST=localhost SMTP_PORT=2525 WEBHOOK_ALLOW_PRIVATE_TARGETS=true SMTP_RELAY_PORT=2587 \
 *     npx concurrently "npm run dev:api" "npm run dev:worker" "npm run dev:smtp"
 *   TREDMAIL_API_KEY=tred_live_... npm run test:developer
 *
 * Takes about two minutes (it waits for a scheduled send and a webhook retry).
 */
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import nodemailer from "nodemailer";
import { verifyWebhook } from "../packages/sdk-node/src/index.js";

const API_URL = (process.env.TREDMAIL_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const MAILPIT_URL = (process.env.MAILPIT_URL ?? "http://localhost:8035").replace(/\/+$/, "");
const RELAY_PORT = Number(process.env.SMTP_RELAY_PORT ?? 2587);
const MTA_INBOUND_PORT = Number(process.env.MTA_INBOUND_PORT ?? 2526);
const PRIMARY_DOMAIN = process.env.PRIMARY_DOMAIN ?? "tredmail.dovepeakdigital.com";
const SENDING_DOMAIN = process.env.DEVELOPER_TEST_DOMAIN ?? "dovepeakdigital.com";
const FROM = `TredMail Developer Test <system@${SENDING_DOMAIN}>`;
const API_KEY = process.env.TREDMAIL_API_KEY;
const WEBHOOK_PORT = Number(process.env.WEBHOOK_TEST_PORT ?? 4599);

if (!API_KEY) {
  console.error("Set TREDMAIL_API_KEY to a key with full_access (run `npm run db:seed` to create one).");
  process.exit(1);
}

type Json = Record<string, any>;
const run = Date.now();
const step = (message: string) => console.log(`- ${message}`);

async function api(path: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
      ...init.headers,
    },
  });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => ({}))) as Json };
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

const emailStatus = async (id: string) => (await api(`/v1/emails/${id}`)).body.status as string;
const waitForStatus = (id: string, ...statuses: string[]) =>
  waitFor(`email ${id} to become ${statuses.join(" or ")}`, async () => {
    const status = await emailStatus(id);
    return statuses.includes(status) ? status : undefined;
  }, 60_000);

async function mailpitMessage(subject: string) {
  return waitFor(`Mailpit message "${subject}"`, async () => {
    const search = (await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`).then((r) => r.json())) as Json;
    const found = search.messages?.[0];
    return found ? ((await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`).then((r) => r.json())) as Json) : undefined;
  });
}

async function mailpitCount(subject: string) {
  const search = (await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`).then((r) => r.json())) as Json;
  return (search.messages ?? []).length as number;
}

async function templates() {
  const alias = `welcome-${run}`;
  const created = await api("/v1/templates", {
    method: "POST",
    body: JSON.stringify({
      name: "Welcome",
      alias,
      subject: "Welcome {{name}} {{run}}",
      html: "<p>Hi {{name}}, your plan is {{plan|Free}}.</p><p>{{{signature}}}</p>",
      text: "Hi {{name}}, your plan is {{plan|Free}}.",
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.variables, ["name", "run", "plan", "signature"]);

  const preview = await api(`/v1/templates/${alias}/preview`, { method: "POST", body: JSON.stringify({ variables: { name: "<Amina>" } }) });
  assert.match(preview.body.html, /Hi &lt;Amina&gt;, your plan is Free/);
  assert.deepEqual(preview.body.missing_variables, ["run", "signature"]);

  const missing = await api("/v1/emails", { method: "POST", body: JSON.stringify({ from: FROM, to: "t@example.com", template: alias, variables: { name: "A" } }) });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error, "missing_template_variables");

  const sent = await api("/v1/emails", {
    method: "POST",
    body: JSON.stringify({ from: FROM, to: "template@example.com", template: alias, variables: { name: "Amina", run, signature: "<b>Dovepeak</b>" } }),
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const message = await mailpitMessage(`Welcome Amina ${run}`);
  assert.match(message.HTML, /your plan is Free\.<\/p><p><b>Dovepeak<\/b>/);
  const detail = await api(`/v1/emails/${sent.body.id}`);
  assert.equal(detail.body.template.alias, alias);
  step("templates: preview, missing-variable check, rendered send with fallback and raw HTML");
  return alias;
}

async function idempotency() {
  const key = `order-${run}`;
  const body = JSON.stringify({ from: FROM, to: "idem@example.com", subject: `Idempotent ${run}`, text: "once" });
  const first = await api("/v1/emails", { method: "POST", body, idempotencyKey: key });
  const second = await api("/v1/emails", { method: "POST", body, idempotencyKey: key });
  assert.equal(first.status, 200);
  assert.equal(second.body.id, first.body.id, "a retried request returns the same email");
  assert.equal(second.headers.get("idempotent-replayed"), "true");
  const reused = await api("/v1/emails", { method: "POST", body: body.replace("once", "twice"), idempotencyKey: key });
  assert.equal(reused.status, 422);
  assert.equal(reused.body.error, "idempotency_key_reused");
  await mailpitMessage(`Idempotent ${run}`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await mailpitCount(`Idempotent ${run}`), 1, "only one email was sent");
  step("idempotency: retry returns the original email, reused key with a new body refused, one email sent");
}

async function scheduling() {
  const inAnHour = new Date(Date.now() + 3600_000).toISOString();
  const scheduled = await api("/v1/emails", {
    method: "POST",
    body: JSON.stringify({ from: FROM, to: "later@example.com", subject: `Scheduled ${run}`, text: "later", scheduled_at: inAnHour, tags: [{ name: "run", value: String(run) }] }),
  });
  assert.equal(scheduled.body.status, "scheduled");
  const moved = await api(`/v1/emails/${scheduled.body.id}`, { method: "PATCH", body: JSON.stringify({ scheduled_at: new Date(Date.now() + 7200_000).toISOString() }) });
  assert.equal(moved.body.status, "scheduled");
  const canceled = await api(`/v1/emails/${scheduled.body.id}/cancel`, { method: "POST" });
  assert.equal(canceled.body.status, "canceled");
  const again = await api(`/v1/emails/${scheduled.body.id}/cancel`, { method: "POST" });
  assert.equal(again.status, 409, "a canceled email cannot be canceled again");

  const soon = await api("/v1/emails", {
    method: "POST",
    body: JSON.stringify({ from: FROM, to: "soon@example.com", subject: `Soon ${run}`, text: "soon", scheduled_at: new Date(Date.now() + 8000).toISOString(), tags: [{ name: "run", value: String(run) }] }),
  });
  assert.equal(soon.body.status, "scheduled");
  assert.equal(await emailStatus(soon.body.id), "scheduled");
  await waitForStatus(soon.body.id, "sent", "delivered");
  await mailpitMessage(`Soon ${run}`);

  const listed = await api(`/v1/emails?status=canceled,delivered,sent&tag=run:${run}`);
  const ids = listed.body.data.map((e: Json) => e.id);
  assert.ok(ids.includes(scheduled.body.id) && ids.includes(soon.body.id), "filtered list finds both emails by status and tag");
  assert.equal(await mailpitCount(`Scheduled ${run}`), 0, "the canceled email was never sent");
  step("scheduling: reschedule, cancel (not sent), and an 8-second schedule sent on time; list filters by status and tag");
  return scheduled.body.id as string;
}

async function webhooks() {
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  let failNext = 1;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (failNext > 0) {
        failNext--;
        res.writeHead(500).end("temporary failure");
      } else {
        res.writeHead(200).end("ok");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(WEBHOOK_PORT, "127.0.0.1", resolve));

  const created = await api("/v1/webhooks", {
    method: "POST",
    body: JSON.stringify({ url: `http://127.0.0.1:${WEBHOOK_PORT}/hooks`, subscribed_to: ["email.queued"] }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id: webhookId, secret } = created.body;

  const sent = await api("/v1/emails", { method: "POST", body: JSON.stringify({ from: FROM, to: "hook@example.com", subject: `Hook ${run}`, text: "x" }) });
  const delivery = await waitFor(
    "webhook retry to succeed",
    async () => {
      const page = await api(`/v1/webhooks/${webhookId}/deliveries`);
      const d = page.body.data.find((x: Json) => x.payload?.data?.email_id === sent.body.id);
      return d?.status === "succeeded" ? d : undefined;
    },
    90_000,
  );
  assert.equal(delivery.attempts, 2, "failed once, then delivered on the retry");
  assert.equal(received.length, 2);
  assert.equal(received[0].headers["webhook-id"], received[1].headers["webhook-id"], "retries keep the same webhook-id");
  const event = verifyWebhook({ secret, headers: received[1].headers as Record<string, string>, body: received[1].body });
  assert.equal(event.type, "email.queued");

  const replay = await api(`/v1/webhooks/${webhookId}/deliveries/${delivery.id}/replay`, { method: "POST" });
  assert.equal(replay.status, 202);
  await waitFor("replayed delivery", async () => (received.length >= 3 ? true : undefined));
  assert.equal(received[2].headers["webhook-id"], received[0].headers["webhook-id"], "a replay keeps the webhook-id");

  const paused = await api(`/v1/webhooks/${webhookId}`, { method: "PATCH", body: JSON.stringify({ is_active: false }) });
  assert.equal(paused.body.is_active, false);
  await api(`/v1/webhooks/${webhookId}`, { method: "DELETE" });
  server.close();
  step("webhooks: failed attempt retried with the same webhook-id, signature verified by the SDK, replay, pause");
}

async function smtpRelay() {
  const subject = `Relay ${run}`;
  const relay = (password: string) =>
    nodemailer.createTransport({ host: "localhost", port: RELAY_PORT, secure: false, ignoreTLS: true, auth: { user: "tredmail", pass: password } });

  const denied = await relay("tred_live_wrong")
    .sendMail({ from: FROM, to: "relay@example.com", subject, text: "x" })
    .then(() => "accepted", (err: Error & { responseCode?: number }) => err.responseCode);
  assert.equal(denied, 535, "a wrong API key is refused");

  const transport = relay(API_KEY!);
  const messageId = `<relay-${run}@${SENDING_DOMAIN}>`;
  const message = {
    from: FROM,
    to: "relay@example.com",
    bcc: "relay-bcc@example.com",
    subject,
    html: `<p>Sent through the SMTP relay</p><img src="cid:logo-${run}">`,
    messageId,
    headers: { "X-TredMail-Tags": `category=relay, run=${run}`, "X-Order-Id": "A-17" },
    attachments: [{ filename: "logo.png", content: Buffer.from("89504e470d0a1a0a", "hex"), cid: `logo-${run}` }],
  };
  const info = await transport.sendMail(message);
  assert.match(info.response, /^250 2\.0\.0 Queued as \w+/);
  const id = info.response.match(/Queued as (\w+)/)![1];

  const retry = await transport.sendMail(message);
  assert.match(retry.response, /Already accepted/, "the same Message-ID is not sent twice");
  transport.close();

  const received = await mailpitMessage(subject);
  assert.equal(received.Inline?.length ?? 0, 1, "the inline image arrives as an inline part");
  const headers = (await fetch(`${MAILPIT_URL}/api/v1/message/${received.ID}/headers`).then((r) => r.json())) as Json;
  assert.ok(headers["Dkim-Signature"]?.[0]?.includes(`d=${SENDING_DOMAIN}`), "relayed mail is DKIM-signed");
  assert.equal(headers["X-Order-Id"]?.[0], "A-17", "custom X- headers are kept");
  const detail = await api(`/v1/emails/${id}`);
  assert.deepEqual(detail.body.bcc, ["relay-bcc@example.com"], "envelope-only recipients become Bcc");
  assert.ok(detail.body.tags.some((t: Json) => t.name === "category" && t.value === "relay"));
  step("SMTP relay: wrong key refused, message accepted with Bcc, tags, custom header and inline image, DKIM-signed, retry deduplicated");
}

async function outbox(scheduledCanceledId: string) {
  // Simulate Redis losing a scheduled job, then run the sweeper as if two hours had passed.
  const { emailQueue } = await import("../packages/core/src/queue/email.queue.js");
  const { sweepOutbox } = await import("../apps/worker/src/monitor.js");
  const later = await api("/v1/emails", {
    method: "POST",
    body: JSON.stringify({ from: FROM, to: "outbox@example.com", subject: `Outbox ${run}`, text: "x", scheduled_at: new Date(Date.now() + 3600_000).toISOString() }),
  });
  await (await emailQueue.getJob(later.body.id))?.remove();
  assert.equal(await emailQueue.getJob(later.body.id), undefined, "job removed from Redis");
  await sweepOutbox(new Date(Date.now() + 2 * 3600_000));
  const restored = await waitFor("restored job", async () => {
    const job = await emailQueue.getJob(later.body.id);
    return job && (await job.isDelayed()) ? job : undefined;
  });
  assert.ok(restored.delay > 0 || restored.opts.delay! > 0 || (await restored.isDelayed()), "re-queued and waiting for its time");
  assert.equal(await emailStatus(later.body.id), "scheduled", "rebuilt from the database, still scheduled");
  assert.equal(await emailStatus(scheduledCanceledId), "canceled", "canceled emails are not revived");
  await api(`/v1/emails/${later.body.id}/cancel`, { method: "POST" });
  await emailQueue.close();
  step("outbox: a scheduled email whose Redis job was lost is rebuilt from the database");
}

function dmarcReportEmail(domain: string) {
  const xml = `<?xml version="1.0"?><feedback><report_metadata><org_name>google.com</org_name><report_id>dev-${run}</report_id>
<date_range><begin>${Math.floor(run / 1000) - 86400}</begin><end>${Math.floor(run / 1000)}</end></date_range></report_metadata>
<policy_published><domain>${domain}</domain><p>none</p></policy_published>
<record><row><source_ip>203.0.113.5</source_ip><count>12</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row></record>
<record><row><source_ip>198.51.100.9</source_ip><count>3</count><policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row></record>
</feedback>`;
  const gz = zlib.gzipSync(Buffer.from(xml)).toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    "From: noreply-dmarc-support@google.com",
    `To: dmarc@${PRIMARY_DOMAIN}`,
    `Subject: Report domain: ${domain} Submitter: google.com Report-ID: dev-${run}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="dmarc"',
    "",
    "--dmarc",
    "Content-Type: text/plain",
    "",
    "This is an aggregate report.",
    "--dmarc",
    `Content-Type: application/gzip; name="google.com!${domain}!${run}.xml.gz"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="google.com!${domain}!${run}.xml.gz"`,
    "",
    gz,
    "--dmarc--",
    "",
  ].join("\r\n");
}

async function dmarc() {
  const domains = await api("/v1/domains");
  const domain = domains.body.data.find((d: Json) => d.name === SENDING_DOMAIN);
  assert.ok(domain, `${SENDING_DOMAIN} is a domain of this workspace`);
  const inbound = nodemailer.createTransport({ host: "localhost", port: MTA_INBOUND_PORT, secure: false, ignoreTLS: true });
  await inbound.sendMail({ envelope: { from: "noreply-dmarc-support@google.com", to: [`dmarc@${PRIMARY_DOMAIN}`] }, raw: dmarcReportEmail(SENDING_DOMAIN) });
  inbound.close();
  const summary = await waitFor("DMARC report stored", async () => {
    const res = await api(`/v1/domains/${domain.id}/dmarc`);
    return res.body.reports?.some((r: Json) => r.report_id === `dev-${run}`) ? res.body : undefined;
  });
  const source = summary.sources.find((s: Json) => s.ip === "198.51.100.9");
  assert.ok(source && source.fail >= 3, "failing source listed");
  step(`DMARC: gzip aggregate report to dmarc@ stored and summarised (${summary.pass_rate}% passing)`);
}

async function analyticsAndDocs() {
  const series = await api("/v1/stats/timeseries?days=7");
  assert.equal(series.body.data.length, 7);
  const today = series.body.data[6];
  assert.ok(today.sent > 0 || today.delivered > 0, "today's sends are counted");
  const perDomain = await api("/v1/stats/domains?days=7");
  assert.ok(perDomain.body.data.some((d: Json) => d.domain === SENDING_DOMAIN));
  const spec = await fetch(`${API_URL}/v1/openapi.json`).then((r) => r.json() as Promise<Json>);
  assert.ok(spec.paths["/emails/{id}/cancel"], "OpenAPI spec is served");
  step(`analytics: daily series (today: ${today.sent} sent, ${today.delivered} delivered) and per-domain totals; OpenAPI served`);
}

async function main() {
  const ready = await fetch(`${API_URL}/health/ready`);
  assert.equal(ready.status, 200, "API is not ready");
  step("API ready");
  await templates();
  await idempotency();
  const canceledId = await scheduling();
  await smtpRelay();
  await outbox(canceledId);
  await dmarc();
  await webhooks();
  await analyticsAndDocs();
  console.log("\nDeveloper product test passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nDeveloper product test failed: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});
