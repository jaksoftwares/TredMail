/**
 * Telling people from software in open and click tracking. Security gateways (Microsoft
 * Defender, Proofpoint, Mimecast, Barracuda...) fetch every link when a message arrives, link
 * previewers fetch them when a link is pasted, and Apple Mail Privacy Protection downloads
 * every image whether or not the message is read. Such events are kept (flagged `bot`) but left
 * out of stats and webhooks.
 *
 * Gmail's and Yahoo's image proxies (GoogleImageProxy, YahooMailProxy) are NOT bots: they fetch
 * the pixel when the person opens the message.
 */

const AUTOMATED_AGENT =
  /bot\b|crawler|spider|preview|scanner|headless|phantomjs|curl\/|wget\/|python-requests|python-urllib|aiohttp|go-http-client|java\/|okhttp|libwww|httpclient|axios\/|node-fetch|undici|barracuda|proofpoint|mimecast|symantec|messagelabs|trendmicro|forcepoint|fortiguard|sophos|bitdefender|kaspersky|safelinks|microsoft office protocol discovery|ms-office|facebookexternalhit|slackbot|linkedinbot|twitterbot|whatsapp|discordbot|telegrambot|skypeuripreview/i;

const HUMAN_MAIL_PROXY = /googleimageproxy|yahoomailproxy/i;

/** Clicks this soon after the hand-off are scanners following every link on arrival. */
export const SCANNER_CLICK_WINDOW_MS = 10_000;

export interface TrackingHit {
  kind: "open" | "click";
  userAgent: string | null | undefined;
  /** When the email was handed to the mail server (its SENT event), if known */
  sentAt: Date | null;
  at: Date;
}

export function classifyTrackingHit(hit: TrackingHit): { bot: boolean; reason?: string } {
  const ua = (hit.userAgent ?? "").trim();
  if (!ua) return { bot: true, reason: "no_user_agent" };
  if (HUMAN_MAIL_PROXY.test(ua)) return { bot: false };
  if (AUTOMATED_AGENT.test(ua)) return { bot: true, reason: "automated_agent" };
  // Apple Mail Privacy Protection prefetches images with this bare user agent
  if (hit.kind === "open" && ua === "Mozilla/5.0") return { bot: true, reason: "privacy_prefetch" };
  if (hit.kind === "click" && hit.sentAt && hit.at.getTime() - hit.sentAt.getTime() < SCANNER_CLICK_WINDOW_MS) {
    return { bot: true, reason: "clicked_on_arrival" };
  }
  return { bot: false };
}
