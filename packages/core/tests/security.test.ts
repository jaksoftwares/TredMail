import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/security/crypto.js";
import { generateApiKey, hashApiKey } from "../src/security/api-keys.js";
import { signWebhookPayload } from "../src/webhooks/dispatcher.js";

describe("secret encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("private-key");
    const b = encryptSecret("private-key");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("private-key");
  });

  it("detects tampering", () => {
    const [iv, tag, data] = encryptSecret("private-key").split(":");
    const flipped = (data[0] === "0" ? "1" : "0") + data.slice(1);
    expect(() => decryptSecret(`${iv}:${tag}:${flipped}`)).toThrow();
  });
});

describe("api keys", () => {
  it("stores only a hash and shows a non-secret prefix", () => {
    const key = generateApiKey(true);
    expect(key.plaintextKey).toMatch(/^tred_live_[0-9a-f]{48}$/);
    expect(key.keyHash).toBe(hashApiKey(key.plaintextKey));
    expect(key.keyPrefix.length).toBeLessThan(key.plaintextKey.length);
  });
});

describe("webhook signatures", () => {
  it("follows the Standard Webhooks scheme", () => {
    const raw = Buffer.from("k".repeat(24));
    const secret = `whsec_${raw.toString("base64")}`;
    const expected = crypto.createHmac("sha256", raw).update("msg_1.1700000000.{}").digest("base64");
    expect(signWebhookPayload(secret, "msg_1", 1700000000, "{}")).toBe(`v1,${expected}`);
  });
});
