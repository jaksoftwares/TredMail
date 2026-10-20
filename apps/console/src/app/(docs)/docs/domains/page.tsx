import type { Metadata } from "next";
import Link from "next/link";
import { C, Code, DefTable, DocTitle, H2, List, Note, P } from "@/components/docs";

export const metadata: Metadata = { title: "Domains and DNS" };

export default function DomainsDocsPage() {
  return (
    <>
      <DocTitle
        title="Domains and DNS"
        lead="Mailbox providers deliver mail they can trust. Four DNS records prove that TredMail may send for your domain and keep your messages out of spam."
      />

      <H2>The records</H2>
      <DefTable
        head={["Record", "Type", "Why"]}
        rows={[
          ["DKIM", "TXT", <>A public key at <C>tredmail._domainkey</C>. TredMail signs every message with the matching private key, so receivers know it is genuine and unaltered.</>],
          ["SPF", "TXT", <>Lists the servers allowed to send for the domain. Add <C>include:_spf.tredmail.dovepeakdigital.com</C>.</>],
          ["DMARC", "TXT", <>At <C>_dmarc</C>: what receivers should do with mail that fails, and where to send daily reports. TredMail reads those reports and shows them on the domain page.</>],
          ["Return path", "CNAME", <><C>bounces</C> points at TredMail, so bounces come back to us and SPF aligns with your From address. Recommended.</>],
        ]}
      />
      <P>
        The console&apos;s domain page lists the exact values with copy buttons, re-checks while you have it open, and offers a test send once everything is found.
      </P>

      <H2>If you already have SPF or DMARC</H2>
      <P>A domain can have only one SPF record. If it already has one (for example for Google Workspace, Zoho Mail or Microsoft 365), add TredMail to it:</P>
      <Code title="One combined SPF record" code="v=spf1 include:zohomail.com include:_spf.tredmail.dovepeakdigital.com ~all" />
      <P>Keep an existing DMARC record. To see TredMail&apos;s DMARC reports, add our address to its <C>rua=</C> list:</P>
      <Code title="_dmarc" code="v=DMARC1; p=none; rua=mailto:you@your-domain.com,mailto:dmarc@tredmail.dovepeakdigital.com" />

      <H2>DMARC policy</H2>
      <List
        items={[
          <>Start with <C>p=none</C>: nothing is blocked, and reports show which services send as your domain.</>,
          "After two to four weeks, when the DMARC panel shows all your legitimate mail passing, move to p=quarantine (failing mail goes to spam), and later p=reject.",
          "Failures from IPs you recognise are a service of yours without DKIM or SPF set up. Failures from unknown IPs are usually spoofing, which a stricter policy stops.",
        ]}
      />

      <H2>DNS provider tips</H2>
      <List
        items={[
          <>Most panels (Namecheap, GoDaddy, Hostinger) want the <strong>Host</strong> value only, e.g. <C>tredmail._domainkey</C>, and add the domain themselves.</>,
          "Cloudflare: set the return-path CNAME to DNS only (grey cloud). Proxied records break mail.",
          "Changes usually appear within 30 minutes, occasionally a few hours.",
        ]}
      />
      <Note>
        Sending from a subdomain such as <C>mail.your-domain.com</C> keeps its reputation separate from your staff mail. Add the subdomain as the domain in{" "}
        <Link href="/domains" className="font-semibold underline">Domains</Link>.
      </Note>
    </>
  );
}
