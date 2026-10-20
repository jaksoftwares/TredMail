/**
 * Staging allowlist: comma-separated addresses (`qa@dovepeakdigital.com`) and domains
 * (`@dovepeakdigital.com`). Only messages whose every recipient matches are delivered for
 * real from staging; everything else is still caught by Mailpit.
 */
export function parseAllowlist(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 1 && entry.includes("@"));
}

export function isStagingAllowlisted(address: string, allowlist: readonly string[]): boolean {
  const lower = address.trim().toLowerCase();
  const domain = lower.slice(lower.lastIndexOf("@"));
  return allowlist.some((entry) => (entry.startsWith("@") ? domain === entry : lower === entry));
}
