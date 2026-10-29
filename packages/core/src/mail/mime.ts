import type { TrackingSigner } from "../security/tracking-signature.js";

export interface CompiledContent {
  html?: string;
  text?: string;
}

export interface TrackingOptions {
  trackOpens?: boolean;
  trackClicks?: boolean;
  /** Public base URL of the tracking routes, e.g. https://track.tredmail.dovepeakdigital.com/v1/track */
  trackingBaseUrl: string;
  signer: TrackingSigner;
}

// Path or query segments that mark account-security links: password resets, verification,
// magic sign-in, invitations, unsubscribes. They are never sent through the click tracker,
// which would expose the token to another server and to link scanners.
const SECURITY_SEGMENT =
  /(^|[/?&=_.#-])(reset|password|passwd|verify|verification|confirm|confirmation|magic|magic-link|login|log-in|signin|sign-in|auth|oauth|token|otp|2fa|mfa|invite|invitation|activate|activation|unsubscribe)([/?&=_.#-]|$)/i;

/** Whether a link looks like an account-security action (see SECURITY_SEGMENT). */
export function isSecurityLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SECURITY_SEGMENT.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

/** TredMail's one-click unsubscribe headers (RFC 8058) for an email with `unsubscribe: true`. */
export function unsubscribeHeaders(emailId: string, trackingBaseUrl: string, signer: TrackingSigner): Record<string, string> {
  const base = trackingBaseUrl.replace(/\/+$/, "");
  const url = `${base}/unsubscribe/${encodeURIComponent(emailId)}?sig=${signer.signUnsubscribe(emailId)}`;
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

/**
 * Injects the open-tracking pixel and rewrites links for click tracking. Security links
 * (isSecurityLink) and links marked `data-tredmail-notrack` are left as they are.
 * Every generated URL carries an HMAC signature that the tracking routes verify.
 */
export function prepareEmailBody(
  emailId: string,
  html: string | undefined,
  text: string | undefined,
  options: TrackingOptions
): CompiledContent {
  const trackOpens = options.trackOpens ?? true;
  const trackClicks = options.trackClicks ?? true;

  if (!html) {
    return { html, text };
  }

  const base = options.trackingBaseUrl.replace(/\/+$/, "");
  const encodedId = encodeURIComponent(emailId);
  let processedHtml = html;

  if (trackClicks) {
    processedHtml = processedHtml.replace(/<a\b[^>]*>/gi, (tag) => {
      // The sender excluded this link: drop the marker attribute and leave the link alone
      if (/\sdata-tredmail-notrack\b/i.test(tag)) return tag.replace(/\s+data-tredmail-notrack(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/i, "");
      return tag.replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/i, (match, _quote: string, originalUrl: string) => {
        // HTML attribute values may contain entities; sign and redirect to the decoded URL.
        const targetUrl = originalUrl.replace(/&amp;/g, "&");
        if (originalUrl.startsWith(base) || isSecurityLink(targetUrl)) return match;
        const sig = options.signer.signClick(emailId, targetUrl);
        const redirectUrl = `${base}/click/${encodedId}?url=${encodeURIComponent(targetUrl)}&sig=${sig}`;
        return `href="${redirectUrl.replace(/&/g, "&amp;")}"`;
      });
    });
  }

  if (trackOpens) {
    const pixelUrl = `${base}/open/${encodedId}?sig=${options.signer.signOpen(emailId)}`;
    const pixelTag = `<img src="${pixelUrl}" width="1" height="1" border="0" alt="" style="height:1px!important;width:1px!important;border-width:0!important;margin:0!important;padding:0!important;" />`;
    processedHtml = /<\/body>/i.test(processedHtml)
      ? processedHtml.replace(/<\/body>/i, `${pixelTag}</body>`)
      : processedHtml + pixelTag;
  }

  return { html: processedHtml, text };
}
