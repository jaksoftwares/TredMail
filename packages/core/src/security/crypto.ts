import crypto from "crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits for GCM

/**
 * Derives a consistent 32-byte key from the master encryption key
 */
function getKey(): Buffer {
  return crypto.createHash("sha256").update(env.TREDMAIL_MASTER_ENCRYPTION_KEY).digest();
}

/**
 * Encrypts a plaintext string (e.g. DKIM private key) using AES-256-GCM.
 * Output format: iv:tag:ciphertext (all hex encoded)
 */
export function encryptSecret(plainText: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted payload back to plaintext UTF-8.
 */
export function decryptSecret(encryptedPayload: string): string {
  const parts = encryptedPayload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload format. Expected iv:tag:ciphertext");
  }

  const [ivHex, tagHex, cipherText] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Invalid encrypted payload: unexpected IV or auth tag length");
  }

  // Pinning the tag length rejects truncated tags, which would make forgery easier.
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(cipherText, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
