export interface DnsRecord {
  recordType: "DKIM" | "SPF" | "DMARC" | "RETURN_PATH";
  type: "TXT" | "CNAME";
  name: string;
  expectedValue: string;
}

export interface DomainRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  records: DnsRecord[];
}
