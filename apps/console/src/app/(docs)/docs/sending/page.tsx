import type { Metadata } from "next";
import Link from "next/link";
import { API_BASE, C, Code, DefTable, DocTitle, H2, List, Note, P } from "@/components/docs";

export const metadata: Metadata = { title: "Sending email" };

export default function SendingPage() {
  return (
    <>
      <DocTitle title="Sending email" lead={<>Everything <C>POST /emails</C> accepts, plus batches, scheduling, safe retries and attachments.</>} />

      <H2>Fields</H2>
      <DefTable
        head={["Field", "Notes"]}
        rows={[
          [<C key="f">from</C>, <>An address on a verified domain, with an optional name: <C>Dovepeak &lt;billing@your-domain.com&gt;</C>.</>],
          [<C key="t">to</C>, "One address or a list, up to 50. Also cc and bcc."],
          [<C key="s">subject</C>, "Required unless a template provides it."],
          [<C key="h">html</C>, <>The HTML body. Send <C>text</C> too: some mail apps and spam filters prefer a plain-text version.</>],
          [<C key="r">reply_to</C>, "Where replies go."],
          [<C key="tg">tags</C>, <>Up to 50 <C>{"{ name, value }"}</C> pairs for filtering. A <C>category</C> tag groups Gmail Postmaster statistics.</>],
          [<C key="hd">headers</C>, <>Custom headers such as <C>X-Order-Id</C>. Standard headers and <C>X-TredMail-*</C> are reserved.</>],
          [<C key="tr">track_opens</C>, <>And <C>track_clicks</C>. On by default. Turn them off for security emails such as password resets.</>],
          [<C key="sa">scheduled_at</C>, "An ISO 8601 time up to 30 days ahead."],
          [<C key="tp">template</C>, <>A template id or alias, with <C>variables</C>. See <Link href="/docs/templates" className="underline">templates</Link>.</>],
        ]}
      />

      <H2>Retry safely with Idempotency-Key</H2>
      <P>
        If a request times out, you cannot know whether TredMail received it. Send an <C>Idempotency-Key</C> header that is unique to the message (an order id, a
        password-reset token id): retrying with the same key and body within 24 hours returns the original email instead of sending a second one.
      </P>
      <Code
        title="curl"
        code={`curl -X POST ${API_BASE}/emails \\
  -H "Authorization: Bearer $TREDMAIL_API_KEY" \\
  -H "Idempotency-Key: receipt-order-10293" \\
  -H "Content-Type: application/json" \\
  -d '{"from":"billing@your-domain.com","to":"customer@example.com","subject":"Receipt #10293","text":"Thank you."}'`}
      />
      <List
        items={[
          <>A replayed response carries the header <C>Idempotent-Replayed: true</C>.</>,
          <>The same key with a different body returns <C>422 idempotency_key_reused</C>.</>,
          <>A second request while the first is still running returns <C>409 idempotency_in_progress</C>: retry a few seconds later.</>,
        ]}
      />

      <H2>Schedule for later</H2>
      <Code
        title="JSON body"
        code={`{
  "from": "Dovepeak <news@your-domain.com>",
  "to": "customer@example.com",
  "subject": "Your trial ends tomorrow",
  "html": "<p>...</p>",
  "scheduled_at": "2026-11-01T08:00:00+03:00"
}`}
      />
      <P>
        The email stays <strong>scheduled</strong> until then. Move it with <C>{"PATCH /emails/{id}"}</C> and a new <C>scheduled_at</C> (a time in the past sends it now), or stop it
        with <C>{"POST /emails/{id}/cancel"}</C>. Once sending has started it can no longer be canceled.
      </P>

      <H2>Batches</H2>
      <P>
        <C>POST /emails/batch</C> takes an array of up to 100 emails. Each one is accepted or rejected on its own; the response lists the results in the same order.
      </P>

      <H2>Attachments and inline images</H2>
      <Code
        title="attachments"
        code={`"attachments": [
  { "filename": "invoice.pdf", "content": "<base64>", "content_type": "application/pdf" },
  { "filename": "logo.png", "content": "<base64>", "content_type": "image/png", "content_id": "logo" }
]`}
      />
      <P>
        Reference an inline image in the HTML as <C>{'<img src="cid:logo">'}</C>. Up to 20 files; the whole request may be at most 10 MB.
      </P>

      <H2>Errors</H2>
      <P>Every error has the same shape. Branch on <C>error</C>, which is stable; <C>message</C> is for people.</P>
      <Code
        title="422"
        code={`{
  "statusCode": 422,
  "error": "recipient_suppressed",
  "message": "Recipient 'old@example.com' is suppressed (HARD_BOUNCE). Delivery was blocked to protect your sender reputation."
}`}
      />
      <DefTable
        head={["Code", "Meaning"]}
        rows={[
          [<C key="1">domain_not_verified</C>, "Publish the domain's DNS records and verify it."],
          [<C key="2">recipient_suppressed</C>, "The address bounced or complained before. Remove it from Suppressions only if you know it works again."],
          [<C key="3">missing_template_variables</C>, "The template uses variables the request did not provide."],
          [<C key="4">insufficient_scope</C>, "The API key lacks the permission for this call."],
          [<C key="5">rate_limit_exceeded</C>, "Too many requests (429). Retry after a short wait."],
        ]}
      />
      <Note>All endpoints and fields are in the <Link href="/docs/api" className="font-semibold underline">API reference</Link>.</Note>
    </>
  );
}
