import type { FastifyInstance } from "fastify";
import { prisma } from "@tredmail/db";
import { env } from "@tredmail/core/config/env";
import { createTrackingSigner } from "@tredmail/core/security/tracking-signature";

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

export async function trackingRoutes(fastify: FastifyInstance) {
  // GET /v1/track/open/:emailId?sig=... - 1x1 open-tracking pixel
  fastify.get<{ Params: { emailId: string }; Querystring: { sig?: string } }>(
    "/open/:emailId",
    async (request, reply) => {
      const { emailId } = request.params;

      // Always return the pixel so images never render broken; only record signed opens.
      if (signer.verifyOpen(emailId, request.query.sig)) {
        prisma.emailEvent
          .create({
            data: {
              emailId,
              type: "OPENED",
              ipAddress: request.ip,
              userAgent: request.headers["user-agent"]?.slice(0, 512) ?? null,
            },
          })
          .catch((err) => request.log.warn({ err, emailId }, "could not record open event"));
      }

      return reply
        .header("Content-Type", "image/gif")
        .header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0")
        .header("Pragma", "no-cache")
        .header("Expires", "0")
        .send(TRANSPARENT_1X1_GIF);
    }
  );

  // GET /v1/track/click/:emailId?url=...&sig=... - signed click redirect
  fastify.get<{ Params: { emailId: string }; Querystring: { url?: string; sig?: string } }>(
    "/click/:emailId",
    async (request, reply) => {
      const { emailId } = request.params;
      const targetUrl = request.query.url;

      // Fastify has already URL-decoded the query string; do not decode again.
      if (!targetUrl || !isHttpUrl(targetUrl) || !signer.verifyClick(emailId, targetUrl, request.query.sig)) {
        return reply.status(400).type("text/plain").send("This link is invalid or has been altered.");
      }

      prisma.emailEvent
        .create({
          data: {
            emailId,
            type: "CLICKED",
            ipAddress: request.ip,
            userAgent: request.headers["user-agent"]?.slice(0, 512) ?? null,
            linkUrl: targetUrl,
          },
        })
        .catch((err) => request.log.warn({ err, emailId }, "could not record click event"));

      return reply.redirect(targetUrl, 302);
    }
  );
}
