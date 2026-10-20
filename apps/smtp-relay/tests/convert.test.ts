import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { toSendRequests } from "../src/convert.js";

const crlf = (lines: string[]) => lines.join("\r\n");

describe("SMTP message conversion", () => {
  it("maps headers, envelope recipients and TredMail option headers", async () => {
    const parsed = await simpleParser(
      crlf([
        'From: "Dovepeak Billing" <billing@dovepeakdigital.com>',
        "To: Customer <customer@example.com>, not-in-envelope@example.com",
        "Cc: manager@example.com",
        "Reply-To: support@dovepeakdigital.com",
        "Subject: Your receipt",
        "X-Customer-Id: 42",
        "X-TredMail-Tags: category=receipt, plan=pro",
        "X-TredMail-Track-Opens: false",
        "X-Mailer: PHPMailer",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "Thanks",
        "--b",
        "Content-Type: text/html",
        "",
        "<p>Thanks</p>",
        "--b--",
      ]),
    );
    const [request, ...rest] = toSendRequests(parsed, {
      mailFrom: "bounce@dovepeakdigital.com",
      rcptTo: ["customer@example.com", "manager@example.com", "archive@dovepeakdigital.com"],
    });
    expect(rest).toEqual([]);
    expect(request).toMatchObject({
      from: "Dovepeak Billing <billing@dovepeakdigital.com>",
      to: ["customer@example.com"],
      cc: ["manager@example.com"],
      bcc: ["archive@dovepeakdigital.com"],
      reply_to: "support@dovepeakdigital.com",
      subject: "Your receipt",
      html: "<p>Thanks</p>",
      tags: [
        { name: "category", value: "receipt" },
        { name: "plan", value: "pro" },
      ],
      track_opens: false,
      headers: { "X-Customer-Id": "42" },
    });
    expect(request.text?.trim()).toBe("Thanks");
    expect(request.track_clicks).toBeUndefined();
  });

  it("splits a Bcc-only message so recipients never see each other", async () => {
    const parsed = await simpleParser(crlf(["From: news@dovepeakdigital.com", "Subject: Update", "", "Hello"]));
    const requests = toSendRequests(parsed, { mailFrom: "news@dovepeakdigital.com", rcptTo: ["a@example.com", "B@example.com"] });
    expect(requests.map((r) => r.to)).toEqual([["a@example.com"], ["b@example.com"]]);
    expect(requests.every((r) => r.bcc === undefined)).toBe(true);
  });

  it("keeps inline images as cid attachments", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const parsed = await simpleParser(
      crlf([
        "From: a@dovepeakdigital.com",
        "To: b@example.com",
        "Subject: Logo",
        'Content-Type: multipart/related; boundary="r"',
        "",
        "--r",
        "Content-Type: text/html",
        "",
        '<img src="cid:logo@dovepeak">',
        "--r",
        "Content-Type: image/png",
        "Content-Transfer-Encoding: base64",
        "Content-ID: <logo@dovepeak>",
        "Content-Disposition: inline; filename=logo.png",
        "",
        png,
        "--r--",
      ]),
    );
    const [request] = toSendRequests(parsed, { mailFrom: "a@dovepeakdigital.com", rcptTo: ["b@example.com"] });
    expect(request.attachments).toEqual([{ filename: "logo.png", content: png, content_type: "image/png", content_id: "logo@dovepeak" }]);
  });
});
