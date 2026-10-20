import { describe, expect, it } from "vitest";
import { createVerpCodec, returnPathDomainFor } from "../src/mail/verp.js";
import { classifyFailure } from "../src/mail/bounce-classifier.js";
import { parseInboundReport } from "../src/mail/report-parser.js";
import { WARMUP_SCHEDULE, msUntilNextUtcDay, warmupCap } from "../src/delivery/warmup.js";

const KEY = "a".repeat(64);
const EMAIL_ID = "cmvgkysyx0009ixtdd4hv89d7";

describe("VERP", () => {
  const verp = createVerpCodec(KEY);

  it("round-trips an email ID through a signed envelope address", () => {
    const address = verp.encode(EMAIL_ID, "bounces.tredmail.dovepeakdigital.com");
    expect(address).toMatch(/^b-cmvgkysyx0009ixtdd4hv89d7-[0-9a-f]{16}@bounces\.tredmail\.dovepeakdigital\.com$/);
    expect(verp.decode(address)).toBe(EMAIL_ID);
    expect(verp.decode(`<${address.toUpperCase()}>`)).toBe(EMAIL_ID);
  });

  it("rejects forged, foreign and malformed addresses", () => {
    const address = verp.encode(EMAIL_ID, "bounces.example.com");
    expect(verp.decode(address.replace(/-[0-9a-f]{16}@/, "-0000000000000000@"))).toBeNull();
    expect(createVerpCodec("b".repeat(64)).decode(address)).toBeNull();
    expect(verp.decode("postmaster@bounces.example.com")).toBeNull();
    expect(verp.decode("")).toBeNull();
  });

  it("uses a customer's own return path only once its CNAME is verified", () => {
    const shared = "bounces.tredmail.dovepeakdigital.com";
    expect(returnPathDomainFor({ name: "acme.com", returnPathVerified: true }, shared)).toBe("bounces.acme.com");
    expect(returnPathDomainFor({ name: "acme.com", returnPathVerified: false }, shared)).toBe(shared);
    expect(returnPathDomainFor({ name: "tredmail.dovepeakdigital.com", returnPathVerified: false }, shared)).toBe(shared);
  });
});

describe("bounce classification", () => {
  it("suppresses unknown users and non-existent domains", () => {
    expect(classifyFailure({ status: "5.1.1", diagnostic: "550 5.1.1 The email account that you tried to reach does not exist." })).toEqual({
      category: "invalid_recipient",
      permanent: true,
      suppress: true,
    });
    expect(classifyFailure({ smtpCode: 550, diagnostic: "550 No such user here" }).suppress).toBe(true);
    expect(classifyFailure({ status: "5.1.2", diagnostic: "Host or domain name not found" })).toMatchObject({ category: "bad_domain", suppress: true });
    expect(classifyFailure({ status: "5.4.4" }).category).toBe("bad_domain");
  });

  it("never suppresses for reputation, policy or content blocks", () => {
    const gmailBlock = classifyFailure({ status: "5.7.1", diagnostic: "550-5.7.1 Our system has detected that this message is likely unsolicited mail." });
    expect(gmailBlock).toMatchObject({ category: "blocked", permanent: true, suppress: false });
    const microsoft = classifyFailure({
      status: "5.7.1",
      diagnostic: "550 5.7.1 Unfortunately, messages from [203.0.113.5] weren't sent. Please contact your Internet service provider since part of their network is on our block list (S3150).",
    });
    expect(microsoft.suppress).toBe(false);
    // Some servers misreport a spam block as an unknown-user code: the text wins
    expect(classifyFailure({ status: "5.1.1", diagnostic: "550 5.1.1 Rejected: sender IP listed at Spamhaus" }).suppress).toBe(false);
    expect(classifyFailure({ status: "5.6.0", diagnostic: "Message content rejected" })).toMatchObject({ category: "content", suppress: false });
  });

  it("treats full mailboxes and temporary codes as non-suppressing", () => {
    expect(classifyFailure({ status: "5.2.2", diagnostic: "Mailbox full" })).toMatchObject({ category: "mailbox_full", suppress: false });
    expect(classifyFailure({ status: "4.2.0", diagnostic: "Try again later" })).toMatchObject({ permanent: false, suppress: false });
    expect(classifyFailure({ smtpCode: 421 })).toMatchObject({ category: "temporary", permanent: false });
  });

  it("uses KumoMTA's classifier label when the code is generic", () => {
    expect(classifyFailure({ status: "5.0.0", mtaClassification: "InvalidRecipient" }).suppress).toBe(true);
    expect(classifyFailure({ smtpCode: 554, mtaClassification: "SpamBlock" }).suppress).toBe(false);
  });
});

const crlf = (lines: string[]) => lines.join("\r\n");

describe("inbound report parser", () => {
  it("reads a Gmail-style DSN with the original message quoted", () => {
    const raw = crlf([
      "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      "Subject: Delivery Status Notification (Failure)",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Address not found",
      "--b1",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; googlemail.com",
      "",
      "Final-Recipient: rfc822; Gone@Example.com",
      "Action: failed",
      "Status: 5.1.1",
      "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does",
      " not exist.",
      "",
      "--b1",
      "Content-Type: message/rfc822",
      "",
      `X-TredMail-ID: ${EMAIL_ID}`,
      "Subject: Hello",
      "",
      "Body",
      "--b1--",
      "",
    ]);
    const report = parseInboundReport(raw);
    expect(report).toEqual({
      kind: "dsn",
      originalEmailId: EMAIL_ID,
      recipients: [
        {
          recipient: "gone@example.com",
          action: "failed",
          status: "5.1.1",
          diagnostic: "550-5.1.1 The email account that you tried to reach does not exist.",
        },
      ],
    });
  });

  it("reads a delayed-delivery DSN encoded in base64", () => {
    const status = Buffer.from("Reporting-MTA: dns; mx.example\r\n\r\nFinal-Recipient: rfc822;slow@example.com\r\nAction: delayed\r\nStatus: 4.4.7\r\n").toString("base64");
    const raw = crlf([
      'Content-Type: multipart/report; report-type=delivery-status; boundary="x"',
      "",
      "--x",
      "Content-Type: message/delivery-status",
      "Content-Transfer-Encoding: base64",
      "",
      status,
      "--x--",
    ]);
    const report = parseInboundReport(raw);
    expect(report.kind).toBe("dsn");
    expect(report.kind === "dsn" && report.recipients[0]).toMatchObject({ recipient: "slow@example.com", action: "delayed", status: "4.4.7" });
  });

  it("reads an ARF spam complaint and finds the original TredMail ID", () => {
    const raw = crlf([
      "From: staff@hotmail.com",
      'Content-Type: multipart/report; report-type=feedback-report; boundary="arf"',
      "",
      "--arf",
      "Content-Type: text/plain",
      "",
      "This is an email abuse report",
      "--arf",
      "Content-Type: message/feedback-report",
      "",
      "Feedback-Type: abuse",
      "Version: 1",
      "Original-Rcpt-To: <reader@example.com>",
      "",
      "--arf",
      "Content-Type: message/rfc822",
      "",
      `X-TredMail-ID: ${EMAIL_ID}`,
      "Message-ID: <x@example.com>",
      "",
      "Body",
      "--arf--",
    ]);
    expect(parseInboundReport(raw)).toEqual({
      kind: "complaint",
      feedbackType: "abuse",
      originalRecipient: "reader@example.com",
      originalEmailId: EMAIL_ID,
      originalMessageId: "<x@example.com>",
    });
  });

  it("recognises plain-text bounces and ignores auto-replies and ordinary mail", () => {
    const bounce = parseInboundReport(
      crlf(["From: MAILER-DAEMON@old.example", "Subject: Returned mail: see transcript for details", "", "550 5.1.1 <x@old.example>... User unknown"]),
    );
    expect(bounce).toMatchObject({ kind: "unstructured_bounce", status: "5.1.1" });

    const ooo = parseInboundReport(crlf(["From: person@example.com", "Subject: Out of office", "Auto-Submitted: auto-replied", "", "Away"]));
    expect(ooo).toMatchObject({ kind: "other", autoReply: true });

    expect(parseInboundReport(crlf(["From: a@b.com", "Subject: Hello postmaster", "", "Hi"]))).toMatchObject({ kind: "other", autoReply: false });
  });
});

describe("warm-up schedule", () => {
  it("starts at the first step, grows daily and ends after the schedule", () => {
    expect(warmupCap(undefined)).toBeNull();
    expect(warmupCap("2026-11-01", new Date("2026-10-30T12:00:00Z"))).toBe(WARMUP_SCHEDULE[0]);
    expect(warmupCap("2026-11-01", new Date("2026-11-01T23:59:00Z"))).toBe(150);
    expect(warmupCap("2026-11-01", new Date("2026-11-13T00:00:00Z"))).toBe(3000);
    expect(warmupCap("2026-11-01", new Date("2026-11-21T00:00:00Z"))).toBeNull();
  });

  it("covers today's volume on day 1 and 3,000 a day within two weeks", () => {
    expect(WARMUP_SCHEDULE[0]).toBeGreaterThanOrEqual(100);
    expect(WARMUP_SCHEDULE.findIndex((cap) => cap >= 3000)).toBeLessThan(14);
  });

  it("computes the wait until the next UTC day", () => {
    expect(msUntilNextUtcDay(new Date("2026-11-01T23:00:00Z"))).toBe(3_600_000);
  });
});
