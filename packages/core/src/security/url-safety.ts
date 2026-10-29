import dns from "dns/promises";
import net, { type LookupFunction } from "net";
import { Agent, fetch as undiciFetch } from "undici";

export class UnsafeUrlError extends Error {}

const blockedV4 = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  blockedV4.addSubnet(address, prefix, "ipv4");
}

const blockedV6 = new net.BlockList();
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["64:ff9b::", 96], // NAT64 can reach IPv4 internals
] as const) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return blockedV4.check(ip, "ipv4");
  if (net.isIPv6(ip)) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blockedV4.check(mapped[1], "ipv4");
    return blockedV6.check(ip, "ipv6");
  }
  return true;
}

export interface UrlSafetyOptions {
  /** Allow http:// and private/loopback targets. Development only. */
  allowPrivate?: boolean;
  lookup?: (hostname: string) => Promise<string[]>;
}

const defaultLookup = async (hostname: string) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Throws UnsafeUrlError unless `value` is an https URL whose host resolves only to public addresses.
 * Call immediately before every outbound request, not only when the URL is saved, because DNS can change.
 */
export async function assertPublicHttpUrl(value: string, options: UrlSafetyOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError("Not a valid URL.");
  }

  if (options.allowPrivate) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("URL must use http or https.");
    return url;
  }

  if (url.protocol !== "https:") throw new UnsafeUrlError("Webhook URLs must use https.");
  if (url.username || url.password) throw new UnsafeUrlError("URLs must not contain credentials.");

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname) ? [hostname] : await (options.lookup ?? defaultLookup)(hostname).catch(() => []);

  if (addresses.length === 0) throw new UnsafeUrlError(`Could not resolve '${hostname}'.`);
  if (addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError(`'${hostname}' resolves to a private or reserved address.`);
  }
  return url;
}

type LookupEntry = { address: string; family: number };

/**
 * A `lookup` for outbound connections that refuses private and reserved addresses at connect
 * time. assertPublicHttpUrl alone is not enough: the HTTP client resolves the name again, and
 * a DNS server that answers differently the second time (DNS rebinding) could point the request
 * at an internal service. With this lookup the address that is checked is the one connected to.
 */
export function createSafeLookup(
  resolveAll: (hostname: string) => Promise<LookupEntry[]> = async (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
): LookupFunction {
  return (hostname, options, callback) => {
    resolveAll(hostname)
      .then((entries) => {
        if (entries.length === 0) throw new UnsafeUrlError(`Could not resolve '${hostname}'.`);
        if (entries.some((e) => isPrivateAddress(e.address))) {
          throw new UnsafeUrlError(`'${hostname}' resolves to a private or reserved address.`);
        }
        if (options?.all) callback(null, entries);
        else callback(null, entries[0].address, entries[0].family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, ""));
  };
}

let publicOnlyAgent: Agent | null = null;

/**
 * fetch() for URLs supplied by customers (webhooks): https only, no credentials, and connections
 * only to public addresses, checked when the connection is made. Throws UnsafeUrlError.
 */
export async function fetchPublicUrl(url: string, init: Parameters<typeof undiciFetch>[1] = {}) {
  await assertPublicHttpUrl(url);
  publicOnlyAgent ??= new Agent({ connect: { lookup: createSafeLookup() } });
  return undiciFetch(url, { ...init, dispatcher: publicOnlyAgent });
}
