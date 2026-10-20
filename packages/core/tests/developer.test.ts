import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { renderTemplate, renderTemplateString, templateVariableNames } from "../src/mail/template-engine.js";
import { isStagingAllowlisted, parseAllowlist } from "../src/delivery/staging-allowlist.js";
import { decompressReport, parseDmarcAggregateXml, unzipFirstFile } from "../src/mail/dmarc-report.js";
import { WEBHOOK_RETRY_DELAYS_MS } from "../src/webhooks/dispatcher.js";
import { generateExpectedDnsRecords } from "../src/dns/generator.js";

describe("template engine", () => {
  it("escapes values in HTML, keeps them raw in text and with triple braces", () => {
    const vars = { name: "<Amina & co>", link: "https://x.test/?a=1&b=2" };
    expect(renderTemplateString("Hi {{name}}", vars, "html").output).toBe("Hi &lt;Amina &amp; co&gt;");
    expect(renderTemplateString("Hi {{name}}", vars, "text").output).toBe("Hi <Amina & co>");
    expect(renderTemplateString('<a href="{{{link}}}">', vars, "html").output).toBe('<a href="https://x.test/?a=1&b=2">');
  });

  it("supports fallbacks, nested paths and reports missing variables", () => {
    const result = renderTemplateString("{{user.first_name}} / {{plan|Free}} / {{missing}}", { user: { first_name: "Jo" } }, "text");
    expect(result.output).toBe("Jo / Free / ");
    expect(result.missing).toEqual(["missing"]);
    expect(renderTemplateString("{{count}}", { count: 0 }, "text").output).toBe("0");
  });

  it("never reads inherited properties", () => {
    expect(renderTemplateString("{{constructor}}{{toString}}", {}, "text").missing).toEqual(["constructor", "toString"]);
  });

  it("renders a full template and lists its variables", () => {
    const template = { subject: "Reset for {{name}}\r\n", html: "<p>{{name}}</p>", text: "{{name}} {{{url}}}" };
    expect(templateVariableNames(template.subject, template.html, template.text)).toEqual(["name", "url"]);
    const rendered = renderTemplate(template, { name: "Amina", url: "https://x" });
    expect(rendered).toEqual({ subject: "Reset for Amina", html: "<p>Amina</p>", text: "Amina https://x", missing: [] });
  });
});

describe("staging allowlist", () => {
  const list = parseAllowlist(" qa@dovepeakdigital.com, @team.dovepeakdigital.com ,bad-entry");
  it("matches exact addresses and whole domains, case-insensitively", () => {
    expect(list).toEqual(["qa@dovepeakdigital.com", "@team.dovepeakdigital.com"]);
    expect(isStagingAllowlisted("QA@dovepeakdigital.com", list)).toBe(true);
    expect(isStagingAllowlisted("dev@team.dovepeakdigital.com", list)).toBe(true);
    expect(isStagingAllowlisted("dev@evilteam.dovepeakdigital.com", list)).toBe(false);
    expect(isStagingAllowlisted("customer@gmail.com", list)).toBe(false);
  });
});

const DMARC_XML = `<?xml version="1.0"?>
<feedback>
  <report_metadata><org_name>google.com</org_name><report_id>1234567890</report_id>
    <date_range><begin>1792454400</begin><end>1792540799</end></date_range></report_metadata>
  <policy_published><domain>tredmail.dovepeakdigital.com</domain><p>none</p></policy_published>
  <record><row><source_ip>203.0.113.5</source_ip><count>40</count>
    <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>tredmail.dovepeakdigital.com</header_from></identifiers></record>
  <record><row><source_ip>198.51.100.9</source_ip><count>2</count>
    <policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row></record>
</feedback>`;

/** A single-file zip written by hand, as Microsoft and Yahoo send them. */
function zipOf(name: string, content: Buffer): Buffer {
  const data = zlib.deflateRawSync(content);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + nameBuf.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
}

describe("DMARC aggregate reports", () => {
  it("reads gzip, zip and plain XML", () => {
    const xml = Buffer.from(DMARC_XML);
    expect(decompressReport(zlib.gzipSync(xml))).toBe(DMARC_XML);
    expect(unzipFirstFile(zipOf("report.xml", xml)).toString()).toBe(DMARC_XML);
    expect(decompressReport(zipOf("report.xml", xml))).toBe(DMARC_XML);
    expect(decompressReport(xml)).toBe(DMARC_XML);
  });

  it("summarises pass and fail counts per source", () => {
    const report = parseDmarcAggregateXml(DMARC_XML);
    expect(report).toMatchObject({
      reporter: "google.com",
      reportId: "1234567890",
      domain: "tredmail.dovepeakdigital.com",
      policy: "none",
      messageCount: 42,
      dmarcPass: 40,
    });
    expect(report.records[1]).toMatchObject({ ip: "198.51.100.9", count: 2, dkim: "fail", spf: "fail" });
    expect(report.dateBegin.toISOString()).toBe("2026-10-20T00:00:00.000Z");
  });

  it("rejects documents that are not reports", () => {
    expect(() => parseDmarcAggregateXml("<html><body>hi</body></html>")).toThrow();
  });
});

describe("webhook retries", () => {
  it("retries for about a day with growing gaps", () => {
    const total = WEBHOOK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total / 3_600_000).toBeGreaterThan(24);
    expect(total / 3_600_000).toBeLessThan(30);
    expect([...WEBHOOK_RETRY_DELAYS_MS].sort((a, b) => a - b)).toEqual(WEBHOOK_RETRY_DELAYS_MS);
  });
});

describe("DNS records for the domain wizard", () => {
  it("gives each record a host relative to the domain", () => {
    const records = generateExpectedDnsRecords("acme.com", "tredmail", "v=DKIM1; k=rsa; p=x");
    expect(records.map((r) => [r.recordType, r.host])).toEqual([
      ["DKIM", "tredmail._domainkey"],
      ["SPF", "@"],
      ["DMARC", "_dmarc"],
      ["RETURN_PATH", "bounces"],
    ]);
  });
});
