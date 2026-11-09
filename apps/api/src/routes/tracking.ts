import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "@tredmail/db";
import { env } from "@tredmail/core/config/env";
import { redisRequests } from "@tredmail/core/queue/request-redis";
import { createTrackingSigner } from "@tredmail/core/security/tracking-signature";
import { classifyTrackingHit } from "@tredmail/core/mail/engagement";
import { dispatchWebhookEvent } from "@tredmail/core/webhooks/dispatcher";

// Standard 43-byte transparent 1x1 GIF
const TRANSPARENT_1X1_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const signer = createTrackingSigner(env.TREDMAIL_MASTER_ENCRYPTION_KEY);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The email a tracking link belongs to, with when it was handed to the mail server. */
async function loadTracked(emailId: string) {
  return prisma.email.findUnique({
    where: { id: emailId },
    select: {
      id: true,
      organizationId: true,
      from: true,
      to: true,
      cc: true,
      bcc: true,
      subject: true,
      events: { where: { type: "SENT" }, select: { timestamp: true }, orderBy: { timestamp: "asc" }, take: 1 },
    },
  });
}

/** One opened webhook per email and reader address a minute: mail clients reload the pixel. */
async function firstOpenThisMinute(emailId: string, ip: string): Promise<boolean> {
  try {
    return (await redisRequests.set(`tredmail:opened:${emailId}:${ip}`, "1", "EX", 60, "NX")) === "OK";
  } catch {
    return true;
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Shows j***@example.com rather than the full address on the public unsubscribe page. */
const maskAddress = (address: string) => address.replace(/^(.)[^@]*(@.*)$/, "$1***$2");

function page(reply: FastifyReply, status: number, title: string, body: string) {
  return reply
    .status(status)
    .type("text/html; charset=utf-8")
    .header("Cache-Control", "no-store")
    .header("X-Robots-Tag", "noindex")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
        `<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f8f8ff;color:#000027;margin:0;padding:48px 16px}main{max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,39,.12)}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;margin:0 0 16px}button{background:#000027;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;cursor:pointer}</style>` +
        `</head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    );
}

export async function trackingRoutes(fastify: FastifyInstance) {
  // One-click unsubscribe requests (RFC 8058) arrive form-encoded; any body is accepted
  fastify.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => done(null, body));

  // GET /v1/track/open/:emailId?sig=... - 1x1 open-tracking pixel
  fastify.get<{ Params: { emailId: string }; Querystring: { sig?: string } }>("/open/:emailId", async (request, reply) => {
    const { emailId } = request.params;

    // Always return the pixel so images never render broken; only record signed opens.
    if (signer.verifyOpen(emailId, request.query.sig)) {
      void recordEngagement("open", emailId, request.ip, request.headers["user-agent"], null).catch((err) =>
        request.log.warn({ err, emailId }, "could not record open event"),
      );
    }

    return reply
      .header("Content-Type", "image/gif")
      .header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0")
      .header("Pragma", "no-cache")
      .header("Expires", "0")
      .send(TRANSPARENT_1X1_GIF);
  });

  // GET /v1/track/click/:emailId?url=...&sig=... - signed click redirect
  fastify.get<{ Params: { emailId: string }; Querystring: { url?: string; sig?: string } }>("/click/:emailId", async (request, reply) => {
    const { emailId } = request.params;
    const targetUrl = request.query.url;

    // Fastify has already URL-decoded the query string; do not decode again.
    if (!targetUrl || !isHttpUrl(targetUrl) || !signer.verifyClick(emailId, targetUrl, request.query.sig)) {
      return reply.status(400).type("text/plain").send("This link is invalid or has been altered.");
    }

    void recordEngagement("click", emailId, request.ip, request.headers["user-agent"], targetUrl).catch((err) =>
      request.log.warn({ err, emailId }, "could not record click event"),
    );
    return reply.redirect(targetUrl, 302);
  });

  // GET /v1/track/unsubscribe/:emailId?sig=... - confirmation page. A GET never unsubscribes:
  // security scanners follow links, so only the POST below (the mail client's one-click
  // request, or the button on this page) does.
  fastify.get<{ Params: { emailId: string }; Querystring: { sig?: string } }>("/unsubscribe/:emailId", async (request, reply) => {
    const { emailId } = request.params;
    const sig = request.query.sig ?? "";
    if (!signer.verifyUnsubscribe(emailId, sig)) return page(reply, 400, "Link not valid", "<p>This unsubscribe link is invalid or has been altered.</p>");
    const email = await loadTracked(emailId);
    const recipient = email ? [...email.to, ...email.cc, ...email.bcc][0] : undefined;
    if (!email || !recipient) return page(reply, 404, "Link expired", "<p>This email is no longer on record, so the link cannot be used.</p>");
    const sender = email.from.replace(/^.*<([^>]+)>.*$/, "$1").split("@")[1] ?? email.from;
    const action = `${request.url.split("?")[0]}?sig=${encodeURIComponent(sig)}`;
    return page(
      reply,
      200,
      "Unsubscribe",
      `<p>Stop emails from <strong>${escapeHtml(sender)}</strong> to <strong>${escapeHtml(maskAddress(recipient))}</strong>?</p>` +
        `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`,
    );
  });

  // POST /v1/track/unsubscribe/:emailId?sig=... - one-click unsubscribe (RFC 8058)
  fastify.post<{ Params: { emailId: string }; Querystring: { sig?: string } }>("/unsubscribe/:emailId", async (request, reply) => {
    const { emailId } = request.params;
    if (!signer.verifyUnsubscribe(emailId, request.query.sig)) return page(reply, 400, "Link not valid", "<p>This unsubscribe link is invalid or has been altered.</p>");
    const email = await loadTracked(emailId);
    const recipient = email ? [...email.to, ...email.cc, ...email.bcc][0]?.toLowerCase() : undefined;
    if (!email || !recipient) return page(reply, 404, "Link expired", "<p>This email is no longer on record, so the link cannot be used.</p>");

    // An existing suppression (a hard bounce, a complaint) is kept as it is
    await prisma.suppression.upsert({
      where: { organizationId_email: { organizationId: email.organizationId, email: recipient } },
      update: {},
      create: { organizationId: email.organizationId, email: recipient, reason: "UNSUBSCRIBE", smtpDiagnostic: `One-click unsubscribe from email ${email.id}` },
    });
    const recorded = await prisma.emailEvent
      .create({ data: { emailId: email.id, type: "UNSUBSCRIBED", dedupeKey: "unsubscribe", ipAddress: request.ip, details: { recipient } } })
      .then(() => true)
      .catch((err: { code?: string }) => {
        if (err.code === "P2002") return false;
        throw err;
      });
    if (recorded) {
      await dispatchWebhookEvent(email.organizationId, "email.unsubscribed", {
        email_id: email.id,
        from: email.from,
        to: email.to,
        subject: email.subject,
        recipient,
        unsubscribed_at: new Date().toISOString(),
      }).catch((err) => request.log.warn({ err, emailId }, "unsubscribe webhook failed"));
    }
    return page(reply, 200, "You are unsubscribed", `<p>${escapeHtml(maskAddress(recipient))} will not receive more emails from this sender.</p>`);
  });
}

/** Records an open or click; people (not scanners or prefetchers) also trigger the webhook. */
async function recordEngagement(kind: "open" | "click", emailId: string, ip: string, userAgent: string | undefined, linkUrl: string | null) {
  const email = await loadTracked(emailId);
  if (!email) return;
  const at = new Date();
  const verdict = classifyTrackingHit({ kind, userAgent, sentAt: email.events[0]?.timestamp ?? null, at });
  await prisma.emailEvent.create({
    data: {
      emailId,
      type: kind === "open" ? "OPENED" : "CLICKED",
      timestamp: at,
      ipAddress: ip,
      userAgent: userAgent?.slice(0, 512) ?? null,
      linkUrl,
      bot: verdict.bot,
      details: verdict.bot ? { bot: verdict.reason ?? "automated" } : undefined,
    },
  });
  if (verdict.bot) return;
  if (kind === "open" && !(await firstOpenThisMinute(emailId, ip))) return;

  await dispatchWebhookEvent(email.organizationId, kind === "open" ? "email.opened" : "email.clicked", {
    email_id: email.id,
    from: email.from,
    to: email.to,
    subject: email.subject,
    ip_address: ip,
    user_agent: userAgent ?? null,
    ...(kind === "click" ? { link_url: linkUrl, clicked_at: at.toISOString() } : { opened_at: at.toISOString() }),
  });
}
