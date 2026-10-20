export interface DnsRecord {
  recordType: "DKIM" | "SPF" | "DMARC" | "RETURN_PATH";
  type: "TXT" | "CNAME";
  name: string;
  /** Relative to the domain, as DNS panels ask for it ("@" for the domain itself) */
  host: string;
  expectedValue: string;
  ttl?: string;
  /** Found at the last verification (single-domain responses only) */
  verified?: boolean;
}

export interface DomainRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  records: DnsRecord[];
}

/** A template as returned by /v1/templates. */
export interface TemplateRow {
  id: string;
  name: string;
  alias: string;
  subject: string;
  html: string | null;
  text: string | null;
  from: string | null;
  reply_to: string | null;
  variables: string[];
  updated_at: string;
}
