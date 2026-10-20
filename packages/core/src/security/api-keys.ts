import crypto from "crypto";

export interface GeneratedApiKey {
  plaintextKey: string;
  keyPrefix: string;
  keyHash: string;
}

/**
 * Generates a high-entropy TredMail API key.
 * Format: tred_live_<32-byte-hex> or tred_test_<32-byte-hex>
 * Returns plaintext key (to show once to the developer), prefix, and SHA-256 hash (to store in DB).
 */
export function generateApiKey(isLive: boolean = true): GeneratedApiKey {
  const prefix = isLive ? "tred_live_" : "tred_test_";
  const randomBytes = crypto.randomBytes(24).toString("hex");
  const plaintextKey = `${prefix}${randomBytes}`;
  const keyPrefix = `${prefix}${randomBytes.substring(0, 6)}...`;
  const keyHash = hashApiKey(plaintextKey);

  return {
    plaintextKey,
    keyPrefix,
    keyHash,
  };
}

/**
 * Computes the SHA-256 hash of an API key for safe database storage and lookup.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key.trim()).digest("hex");
}
