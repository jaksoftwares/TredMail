import type { Metadata } from "next";
import { C, Code, DefTable, DocTitle, H2, List, Note, P } from "@/components/docs";

export const metadata: Metadata = { title: "Webhooks" };

export default function WebhooksDocsPage() {
  return (
    <>
      <DocTitle
        title="Webhooks"
        lead="TredMail sends an HTTPS POST to your endpoint when an email is delivered, bounces, is opened and so on, signed so you can prove it came from TredMail."
      />

      <H2>Events</H2>
      <DefTable
        head={["Event", "When"]}
        rows={[
          [<C key="q">email.queued</C>, "Accepted by the API (also email.scheduled and email.canceled)."],
          [<C key="s">email.sent</C>, "Handed to TredMail's mail server."],
          [<C key="d">email.delivered</C>, "The recipient's server accepted it."],
          [<C key="df">email.deferred</C>, "Temporarily refused; TredMail keeps retrying for 72 hours."],
          [<C key="b">email.bounced</C>, <>Rejected. <C>bounce_type</C> is <C>hard</C> (address suppressed) or <C>soft</C>; <C>category</C> says why.</>],
          [<C key="f">email.failed</C>, "Not delivered after all retries."],
          [<C key="c">email.complained</C>, "The recipient marked it as spam (address suppressed)."],
          [<C key="o">email.opened</C>, <>And <C>email.clicked</C>, when tracking is on.</>],
        ]}
      />
      <Code
        title="Request body"
        code={`{
  "type": "email.bounced",
  "created_at": "2026-10-20T11:48:08.000Z",
  "data": {
    "email_id": "cmvgkysyx0009ixtdd4hv89d7",
    "recipient": "old@example.com",
    "bounce_type": "hard",
    "category": "invalid_recipient",
    "smtp_status": "5.1.1",
    "suppressed": true
  }
}`}
      />

      <H2>Verify the signature</H2>
      <P>
        Each request has <C>webhook-id</C>, <C>webhook-timestamp</C> and <C>webhook-signature</C> headers (the{" "}
        <a href="https://www.standardwebhooks.com" className="underline">Standard Webhooks</a> format). Verify against the <strong>raw</strong> body, before parsing JSON:
      </P>
      <Code
        title="Node.js (Express)"
        code={`import express from "express";
import { verifyWebhook } from "@dovepeak/tredmail";

app.post("/hooks/tredmail", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyWebhook({ secret: process.env.TREDMAIL_WEBHOOK_SECRET!, headers: req.headers, body: req.body });
  } catch {
    return res.status(401).end();
  }
  // Process event.type / event.data, ignoring webhook-ids you have already handled
  res.status(200).end();
});`}
      />
      <Code
        title="Python (Flask)"
        code={`from tredmail import verify_webhook, WebhookVerificationError

@app.post("/hooks/tredmail")
def tredmail_hook():
    try:
        event = verify_webhook(os.environ["TREDMAIL_WEBHOOK_SECRET"], request.headers, request.get_data())
    except WebhookVerificationError:
        return "", 401
    return "", 200`}
      />
      <P>
        Without an SDK: compute the base64 HMAC-SHA256 of <C>{"{webhook-id}.{webhook-timestamp}.{body}"}</C> with the base64-decoded part of your <C>whsec_</C> secret, and
        compare it to the value after <C>v1,</C> in a constant-time comparison. Reject timestamps more than 5 minutes old.
      </P>

      <H2>Retries and replay</H2>
      <List
        items={[
          "Respond with any 2xx within 10 seconds. Anything else is retried: after 30 seconds, 2 and 10 minutes, then 30 minutes, 1, 2, 4, 8 and 12 hours (about 27 hours in total).",
          <>Every retry of an event has the same <C>webhook-id</C>: store the ids you processed and skip repeats.</>,
          "The console shows every delivery with your endpoint's response. Replay one, or every failed delivery of the last 7 days after an outage on your side.",
          "Pausing an endpoint stops deliveries without deleting it.",
        ]}
      />
      <Note tone="warning">
        Treat webhooks as notifications, not the only record: events can arrive out of order. Fetch <C>{"GET /emails/{id}"}</C> when you need the authoritative status.
      </Note>
    </>
  );
}
