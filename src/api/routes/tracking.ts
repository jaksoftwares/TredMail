import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../db/client.js";

// Standard 43-byte transparent 1x1 GIF binary
const TRANSPARENT_1X1_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

export async function trackingRoutes(fastify: FastifyInstance) {
  // -------------------------------------------------------------
  // GET /track/open/:emailId - 1x1 Transparent Tracking Pixel
  // -------------------------------------------------------------
  fastify.get("/open/:emailId", async (request: FastifyRequest<{ Params: { emailId: string } }>, reply: FastifyReply) => {
    const { emailId } = request.params;
    const ipAddress = request.ip || (request.headers["x-forwarded-for"] as string) || "127.0.0.1";
    const userAgent = request.headers["user-agent"] || "Unknown";

    // Asynchronously record the open event
    prisma.emailEvent
      .create({
        data: {
          emailId,
          type: "OPENED",
          ipAddress,
          userAgent,
        },
      })
      .catch((err) => {
        console.warn(`Could not log open event for email ${emailId}:`, err.message);
      });

    // Return the transparent pixel immediately with cache busting headers
    return reply
      .header("Content-Type", "image/gif")
      .header("Content-Length", TRANSPARENT_1X1_GIF.length.toString())
      .header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0")
      .header("Pragma", "no-cache")
      .header("Expires", "0")
      .send(TRANSPARENT_1X1_GIF);
  });

  // -------------------------------------------------------------
  // GET /track/click/:emailId?url=... - Link Click Redirect Proxy
  // -------------------------------------------------------------
  fastify.get(
    "/click/:emailId",
    async (
      request: FastifyRequest<{
        Params: { emailId: string };
        Querystring: { url?: string };
      }>,
      reply: FastifyReply
    ) => {
      const { emailId } = request.params;
      const targetUrl = request.query.url;
      const ipAddress = request.ip || (request.headers["x-forwarded-for"] as string) || "127.0.0.1";
      const userAgent = request.headers["user-agent"] || "Unknown";

      if (!targetUrl) {
        return reply.status(400).send("Missing target URL parameter");
      }

      const decodedUrl = decodeURIComponent(targetUrl);

      // Record click event
      prisma.emailEvent
        .create({
          data: {
            emailId,
            type: "CLICKED",
            ipAddress,
            userAgent,
            linkUrl: decodedUrl,
          },
        })
        .catch((err) => {
          console.warn(`Could not log click event for email ${emailId}:`, err.message);
        });

      // Redirect user to original target
      return reply.redirect(302, decodedUrl);
    }
  );
}
