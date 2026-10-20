import crypto from "crypto";

/**
 * VERP (variable envelope return path): every message is sent with its own envelope sender,
 * `b-<emailId>-<signature>@<return-path domain>`, so a bounce that comes back later can be
 * matched to the exact email. The HMAC stops anyone forging bounces that would suppress
 * real recipients.
 *
 * Lowercase hex only: some mail servers change the case of the local part.
 */
export interface VerpCodec {
  encode(emailId: string, returnPathDomain: string): string;
  /** The email ID from a VERP address, or null when the address is not a valid TredMail VERP. */
  decode(address: string): string | null;
}

const SIGNATURE_HEX = 16; // 64 bits

export function createVerpCodec(masterKeyHex: string): VerpCodec {
  const key = Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(masterKeyHex, "hex"), Buffer.alloc(0), "tredmail-verp-v1", 32),
  );
  const sign = (emailId: string) => crypto.createHmac("sha256", key).update(emailId).digest("hex").slice(0, SIGNATURE_HEX);

  return {
    encode(emailId, returnPathDomain) {
      return `b-${emailId.toLowerCase()}-${sign(emailId.toLowerCase())}@${returnPathDomain.toLowerCase()}`;
    },
    decode(address) {
      const local = address.trim().replace(/^<|>$/g, "").split("@")[0]?.toLowerCase() ?? "";
      const match = local.match(/^b-([a-z0-9]{8,64})-([0-9a-f]{16})$/);
      if (!match) return null;
      const [, emailId, signature] = match;
      const expected = Buffer.from(sign(emailId));
      const given = Buffer.from(signature);
      return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? emailId : null;
    },
  };
}

/**
 * The domain used in the envelope sender. A customer domain whose `bounces.<domain>` CNAME is
 * verified gets its own aligned return path (better SPF alignment); everyone else uses
 * TredMail's shared bounce domain.
 */
export function returnPathDomainFor(
  domain: { name: string; returnPathVerified: boolean },
  bounceDomain: string,
): string {
  const own = `bounces.${domain.name.toLowerCase()}`;
  if (own === bounceDomain.toLowerCase()) return bounceDomain.toLowerCase();
  return domain.returnPathVerified ? own : bounceDomain.toLowerCase();
}
