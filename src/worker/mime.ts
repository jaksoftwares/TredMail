import { env } from "../config/env.js";

export interface CompiledContent {
  html?: string;
  text?: string;
  trackingPixelUrl?: string;
}

/**
 * Prepares HTML content by injecting the 1x1 transparent tracking pixel
 * and rewriting hyperlinks for click tracking.
 */
export function prepareEmailBody(
  emailId: string,
  html?: string,
  text?: string,
  options?: { trackOpens?: boolean; trackClicks?: boolean }
): CompiledContent {
  const trackOpens = options?.trackOpens ?? true;
  const trackClicks = options?.trackClicks ?? true;

  if (!html) {
    return { html, text };
  }

  let processedHtml = html;
  const trackingBase = `${env.API_BASE_URL}/track`;
  const trackingPixelUrl = `${trackingBase}/open/${emailId}`;

  // 1. Rewrite hyperlinks if click tracking is enabled
  if (trackClicks) {
    // Matches standard href="http(s)://..." attributes
    processedHtml = processedHtml.replace(
      /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
      (match, originalUrl) => {
        // Avoid rewriting tracking or unsubscribe URLs
        if (originalUrl.includes("/track/")) {
          return match;
        }
        const encodedUrl = encodeURIComponent(originalUrl);
        const redirectUrl = `${trackingBase}/click/${emailId}?url=${encodedUrl}`;
        return `href="${redirectUrl}"`;
      }
    );
  }

  // 2. Inject transparent 1x1 GIF tracking pixel before </body> (or at end)
  if (trackOpens) {
    const pixelTag = `<img src="${trackingPixelUrl}" width="1" height="1" border="0" alt="" style="height:1px!important;width:1px!important;border-width:0!important;margin-top:0!important;margin-bottom:0!important;margin-right:0!important;margin-left:0!important;padding-top:0!important;padding-bottom:0!important;padding-right:0!important;padding-left:0!important;display:none!important;" />`;
    if (processedHtml.includes("</body>")) {
      processedHtml = processedHtml.replace("</body>", `${pixelTag}</body>`);
    } else {
      processedHtml += pixelTag;
    }
  }

  return {
    html: processedHtml,
    text,
    trackingPixelUrl,
  };
}
