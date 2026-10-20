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

/**
 * Injects the open-tracking pixel and rewrites links for click tracking.
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
    processedHtml = processedHtml.replace(
      /href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi,
      (match, _quote: string, originalUrl: string) => {
        if (originalUrl.startsWith(base)) {
          return match;
        }
        // HTML attribute values may contain entities; sign and redirect to the decoded URL.
        const targetUrl = originalUrl.replace(/&amp;/g, "&");
        const sig = options.signer.signClick(emailId, targetUrl);
        const redirectUrl = `${base}/click/${encodedId}?url=${encodeURIComponent(targetUrl)}&sig=${sig}`;
        return `href="${redirectUrl.replace(/&/g, "&amp;")}"`;
      }
    );
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
