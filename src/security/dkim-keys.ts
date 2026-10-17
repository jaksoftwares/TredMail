import crypto from "crypto";

export interface GeneratedDkimKeypair {
  publicKeyPem: string;
  privateKeyPem: string;
  dnsTxtValue: string;
}

/**
 * Generates a 2048-bit RSA keypair for DKIM signing.
 * Returns standard PEM representations and the formatted DNS TXT public key value.
 */
export function generateDkimKeypair(): GeneratedDkimKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  // Extract raw base64 string from PEM (strip -----BEGIN PUBLIC KEY----- etc)
  const base64PublicKey = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/[\r\n\s]/g, "");

  const dnsTxtValue = `v=DKIM1; k=rsa; p=${base64PublicKey}`;

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    dnsTxtValue,
  };
}
