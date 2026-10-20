import { env } from "../config/env.js";

export interface ExpectedDnsRecord {
  recordType: "DKIM" | "SPF" | "DMARC" | "RETURN_PATH";
  type: "TXT" | "CNAME";
  /** Fully qualified record name. */
  name: string;
  /** Name relative to the domain, as most DNS panels ask for it ("@" for the domain itself). */
  host: string;
  expectedValue: string;
  ttl: string;
  priority?: number;
}

/**
 * Computes the 4 essential DNS authentication records for any domain registered in TredMail.
 */
export function generateExpectedDnsRecords(
  domainName: string,
  dkimSelector: string,
  dkimDnsValue: string
): ExpectedDnsRecord[] {
  const cleanDomain = domainName.toLowerCase().trim();

  const records: Omit<ExpectedDnsRecord, "host">[] = [
    {
      recordType: "DKIM",
      type: "TXT",
      name: `${dkimSelector}._domainkey.${cleanDomain}`,
      expectedValue: dkimDnsValue,
      ttl: "Auto",
    },
    {
      recordType: "SPF",
      type: "TXT",
      name: cleanDomain,
      expectedValue: `v=spf1 include:_spf.${env.PRIMARY_DOMAIN} ~all`,
      ttl: "Auto",
    },
    {
      recordType: "DMARC",
      type: "TXT",
      name: `_dmarc.${cleanDomain}`,
      // Start at p=none so nothing is blocked while reports confirm all mail passes; move to quarantine later
      expectedValue: `v=DMARC1; p=none; rua=mailto:dmarc@${env.PRIMARY_DOMAIN}; pct=100;`,
      ttl: "Auto",
    },
  ];

  // TredMail's own domain hosts the bounce endpoint itself; a CNAME to itself would be circular.
  const returnPathName = `bounces.${cleanDomain}`;
  if (returnPathName !== env.BOUNCE_DOMAIN.toLowerCase()) {
    records.push({
      recordType: "RETURN_PATH",
      type: "CNAME",
      name: returnPathName,
      expectedValue: env.BOUNCE_DOMAIN,
      ttl: "Auto",
    });
  }
  return withHosts(cleanDomain, records);
}

function withHosts(domain: string, records: Omit<ExpectedDnsRecord, "host">[]): ExpectedDnsRecord[] {
  return records.map((r) => ({ ...r, host: r.name === domain ? "@" : r.name.slice(0, -(domain.length + 1)) }));
}
