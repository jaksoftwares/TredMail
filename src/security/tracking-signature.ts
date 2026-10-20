import crypto from "crypto";

/**
 * Signs open-pixel and click-redirect URLs so the tracking endpoints only act on links
 * TredMail generated. Without this, the click endpoint is an open redirect and the
 * pixel endpoint accepts writes for arbitrary IDs.
 */
export interface TrackingSigner {
  signOpen(emailId: string): string;
  verifyOpen(emailId: string, signature: string | undefined): boolean;
  signClick(emailId: string, url: string): string;
  verifyClick(emailId: string, url: string, signature: string | undefined): boolean;
}

// 128-bit truncated HMAC: short enough for URLs, far beyond brute-force range.
const SIGNATURE_BYTES = 16;

export function createTrackingSigner(masterKeyHex: string): TrackingSigner {
  const key = Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(masterKeyHex, "hex"), Buffer.alloc(0), "tredmail-tracking-v1", 32)
  );

  const sign = (message: string) =>
    crypto.createHmac("sha256", key).update(message).digest().subarray(0, SIGNATURE_BYTES).toString("base64url");

  const verify = (message: string, signature: string | undefined) => {
    if (!signature) return false;
    const expected = Buffer.from(sign(message));
    const given = Buffer.from(signature);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  };

  return {
    signOpen: (emailId) => sign(`open:${emailId}`),
    verifyOpen: (emailId, signature) => verify(`open:${emailId}`, signature),
    signClick: (emailId, url) => sign(`click:${emailId}:${url}`),
    verifyClick: (emailId, url, signature) => verify(`click:${emailId}:${url}`, signature),
  };
}
