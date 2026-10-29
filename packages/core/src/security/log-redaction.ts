/**
 * Request URLs as they may be written to logs. Payment callback URLs end in a secret token
 * (the only proof a callback came from the gateway TredMail registered), so it is removed.
 */
const CALLBACK_TOKEN = /^(\/v1\/payments\/callbacks\/[^/?#]+\/[^/?#]+\/)[^/?#]+/;

export function redactUrl(url: string): string {
  return url.replace(CALLBACK_TOKEN, "$1[redacted]");
}
