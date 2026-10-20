import dns from "dns/promises";

export interface RecordVerificationResult {
  recordType: "DKIM" | "SPF" | "DMARC" | "RETURN_PATH";
  verified: boolean;
  expected: string;
  found?: string;
  error?: string;
}

export interface DomainVerificationReport {
  domain: string;
  isFullyVerified: boolean;
  dkimVerified: boolean;
  spfVerified: boolean;
  dmarcVerified: boolean;
  returnPathVerified: boolean;
  records: RecordVerificationResult[];
}

/**
 * True when the SPF record contains exactly `include:<expectedInclude>` as one of its terms
 * (qualifier allowed, case-insensitive). Substring matches such as `include:_spf.google.com`
 * do not count.
 */
export function spfHasInclude(spfRecord: string, expectedInclude: string): boolean {
  const target = `include:${expectedInclude.toLowerCase().replace(/\.$/, "")}`;
  return spfRecord
    .trim()
    .split(/\s+/)
    .slice(1)
    .some((term) => term.toLowerCase().replace(/^[+?~-]/, "").replace(/\.$/, "") === target);
}

/**
 * Actively queries public DNS to verify SPF, DKIM, DMARC, and Return-Path CNAME.
 */
export async function verifyDomainDns(
  domainName: string,
  dkimSelector: string,
  expectedDkimPublicKey: string,
  expectedSpfInclude: string,
  expectedBounceCname: string
): Promise<DomainVerificationReport> {
  const cleanDomain = domainName.toLowerCase().trim();
  const results: RecordVerificationResult[] = [];

  // 1. Verify DKIM TXT
  const dkimHost = `${dkimSelector}._domainkey.${cleanDomain}`;
  try {
    const txtRecords = await dns.resolveTxt(dkimHost);
    const joinedRecords = txtRecords.map((chunk) => chunk.join(""));
    const matchingRecord = joinedRecords.find((rec) =>
      rec.includes("v=DKIM1") && rec.includes("p=")
    );

    if (matchingRecord) {
      // In DNS, long public keys can be split into chunks, so compare stripped keys
      const strippedExpected = expectedDkimPublicKey.replace(/[\r\n\s]/g, "");
      const strippedFound = matchingRecord.replace(/[\r\n\s]/g, "");
      const isMatch = strippedFound.includes(strippedExpected) || strippedFound === strippedExpected;

      results.push({
        recordType: "DKIM",
        verified: isMatch,
        expected: expectedDkimPublicKey,
        found: matchingRecord,
        error: isMatch ? undefined : "DKIM record found but public key does not match.",
      });
    } else {
      results.push({
        recordType: "DKIM",
        verified: false,
        expected: expectedDkimPublicKey,
        error: "DKIM TXT record not found at " + dkimHost,
      });
    }
  } catch (err: any) {
    results.push({
      recordType: "DKIM",
      verified: false,
      expected: expectedDkimPublicKey,
      error: `DNS lookup failed for ${dkimHost}: ${err.code || err.message}`,
    });
  }

  // 2. Verify SPF TXT
  try {
    const txtRecords = await dns.resolveTxt(cleanDomain);
    const joinedRecords = txtRecords.map((chunk) => chunk.join(""));
    const spfRecord = joinedRecords.find((rec) => rec.startsWith("v=spf1"));

    if (spfRecord) {
      const hasInclude = spfHasInclude(spfRecord, expectedSpfInclude);
      results.push({
        recordType: "SPF",
        verified: hasInclude,
        expected: `include:${expectedSpfInclude}`,
        found: spfRecord,
        error: hasInclude ? undefined : `SPF record found, but missing 'include:${expectedSpfInclude}'`,
      });
    } else {
      results.push({
        recordType: "SPF",
        verified: false,
        expected: `v=spf1 include:${expectedSpfInclude} ~all`,
        error: "No SPF (v=spf1) record found on " + cleanDomain,
      });
    }
  } catch (err: any) {
    results.push({
      recordType: "SPF",
      verified: false,
      expected: `include:${expectedSpfInclude}`,
      error: `DNS lookup failed for SPF: ${err.code || err.message}`,
    });
  }

  // 3. Verify DMARC TXT
  const dmarcHost = `_dmarc.${cleanDomain}`;
  try {
    const txtRecords = await dns.resolveTxt(dmarcHost);
    const joinedRecords = txtRecords.map((chunk) => chunk.join(""));
    const dmarcRecord = joinedRecords.find((rec) => rec.startsWith("v=DMARC1"));

    results.push({
      recordType: "DMARC",
      verified: !!dmarcRecord,
      expected: "v=DMARC1; ...",
      found: dmarcRecord,
      error: dmarcRecord ? undefined : "No DMARC record found at " + dmarcHost,
    });
  } catch (err: any) {
    results.push({
      recordType: "DMARC",
      verified: false,
      expected: "v=DMARC1; ...",
      error: `DNS lookup failed for ${dmarcHost}: ${err.code || err.message}`,
    });
  }

  // 4. Verify Return-Path CNAME
  const bounceHost = `bounces.${cleanDomain}`;
  try {
    const cnameRecords = await dns.resolveCname(bounceHost);
    const matchesCname = cnameRecords.some(
      (cname) => cname.toLowerCase() === expectedBounceCname.toLowerCase()
    );

    results.push({
      recordType: "RETURN_PATH",
      verified: matchesCname,
      expected: expectedBounceCname,
      found: cnameRecords.join(", "),
      error: matchesCname ? undefined : `CNAME points to ${cnameRecords.join(", ")}, expected ${expectedBounceCname}`,
    });
  } catch (err: any) {
    results.push({
      recordType: "RETURN_PATH",
      verified: false,
      expected: expectedBounceCname,
      error: `CNAME lookup failed for ${bounceHost}: ${err.code || err.message}`,
    });
  }

  const dkimVerified = results.find((r) => r.recordType === "DKIM")?.verified || false;
  const spfVerified = results.find((r) => r.recordType === "SPF")?.verified || false;
  const dmarcVerified = results.find((r) => r.recordType === "DMARC")?.verified || false;
  const returnPathVerified = results.find((r) => r.recordType === "RETURN_PATH")?.verified || false;

  return {
    domain: cleanDomain,
    isFullyVerified: dkimVerified && spfVerified && dmarcVerified,
    dkimVerified,
    spfVerified,
    dmarcVerified,
    returnPathVerified,
    records: results,
  };
}
