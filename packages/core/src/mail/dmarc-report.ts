import zlib from "node:zlib";
import { XMLParser } from "fast-xml-parser";

/**
 * DMARC aggregate reports (RFC 7489 appendix C). Receivers such as Google and Microsoft send
 * one report a day per domain to the address in the domain's `rua=` tag, as XML compressed
 * with gzip or zip.
 */

export interface DmarcRecord {
  ip: string;
  count: number;
  disposition: string;
  dkim: "pass" | "fail";
  spf: "pass" | "fail";
  headerFrom?: string;
}

export interface DmarcAggregateReport {
  reporter: string;
  reportId: string;
  domain: string;
  policy?: string;
  dateBegin: Date;
  dateEnd: Date;
  messageCount: number;
  /** Messages that passed DMARC: aligned DKIM or aligned SPF passed. */
  dmarcPass: number;
  records: DmarcRecord[];
}

const MAX_UNCOMPRESSED = 20 * 1024 * 1024;

/** Extracts the first file of a zip archive (DMARC zips hold one XML file). */
export function unzipFirstFile(zip: Buffer): Buffer {
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("corrupt zip central directory");
  const method = zip.readUInt16LE(centralOffset + 10);
  const compressedSize = zip.readUInt32LE(centralOffset + 20);
  const localOffset = zip.readUInt32LE(centralOffset + 42);
  if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("corrupt zip local header");
  const nameLength = zip.readUInt16LE(localOffset + 26);
  const extraLength = zip.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = zip.subarray(start, start + compressedSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED });
  throw new Error(`unsupported zip compression method ${method}`);
}

/** Decompresses a report attachment by its magic bytes (gzip, zip or plain XML). */
export function decompressReport(content: Buffer): string {
  if (content[0] === 0x1f && content[1] === 0x8b) return zlib.gunzipSync(content, { maxOutputLength: MAX_UNCOMPRESSED }).toString("utf8");
  if (content[0] === 0x50 && content[1] === 0x4b) return unzipFirstFile(content).toString("utf8");
  return content.toString("utf8");
}

const asArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const str = (value: unknown) => (value === undefined || value === null ? undefined : String(value).trim());

export function parseDmarcAggregateXml(xml: string): DmarcAggregateReport {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false });
  const doc = parser.parse(xml);
  const feedback = doc?.feedback;
  if (!feedback?.report_metadata || !feedback?.policy_published) throw new Error("not a DMARC aggregate report");

  const meta = feedback.report_metadata;
  const published = feedback.policy_published;
  type XmlRecord = {
    row?: { source_ip?: unknown; count?: unknown; policy_evaluated?: { disposition?: unknown; dkim?: unknown; spf?: unknown } };
    identifiers?: { header_from?: unknown };
  };
  const records: DmarcRecord[] = asArray<XmlRecord>(feedback.record).map((record) => {
    const row = record?.row ?? {};
    const evaluated = row.policy_evaluated ?? {};
    return {
      ip: str(row.source_ip) ?? "unknown",
      count: Number(str(row.count) ?? 0) || 0,
      disposition: str(evaluated.disposition) ?? "none",
      dkim: str(evaluated.dkim) === "pass" ? "pass" : "fail",
      spf: str(evaluated.spf) === "pass" ? "pass" : "fail",
      headerFrom: str(record?.identifiers?.header_from),
    };
  });

  const begin = Number(str(meta.date_range?.begin));
  const end = Number(str(meta.date_range?.end));
  if (!Number.isFinite(begin) || !Number.isFinite(end)) throw new Error("report has no date range");

  return {
    reporter: str(meta.org_name) ?? "unknown",
    reportId: str(meta.report_id) ?? `${begin}`,
    domain: (str(published.domain) ?? "").toLowerCase(),
    policy: str(published.p),
    dateBegin: new Date(begin * 1000),
    dateEnd: new Date(end * 1000),
    messageCount: records.reduce((sum, r) => sum + r.count, 0),
    dmarcPass: records.filter((r) => r.dkim === "pass" || r.spf === "pass").reduce((sum, r) => sum + r.count, 0),
    records,
  };
}
