import type { Metadata } from "next";
import Link from "next/link";
import { API_BASE, C, Code, DocTitle, H2, List, Note, P } from "@/components/docs";

export const metadata: Metadata = { title: "Quickstart" };

export default function QuickstartPage() {
  return (
    <>
      <DocTitle
        title="Send your first email"
        lead="TredMail is the transactional email service of Dovepeak Technologies: receipts, password resets, alerts and every other message your applications send. This page takes you from nothing to a delivered email in about five minutes."
      />

      <H2>1. Create an API key</H2>
      <P>
        In the console, open <Link href="/api-keys" className="font-semibold underline">API keys</Link> and create a key with the{" "}
        <C>emails:send</C> permission. Keys start with <C>tred_live_</C> and are shown once: keep yours in an environment variable such as{" "}
        <C>TREDMAIL_API_KEY</C>, never in code.
      </P>

      <H2>2. Send from the sandbox</H2>
      <P>
        Before you verify a domain, you can send from <C>onboarding@tredmail.dovepeakdigital.com</C> to the members of your workspace (50 a day). It is the quickest way to see the API work.
      </P>
      <Code
        title="curl"
        code={`curl -X POST ${API_BASE}/emails \\
  -H "Authorization: Bearer $TREDMAIL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "onboarding@tredmail.dovepeakdigital.com",
    "to": "you@your-company.com",
    "subject": "Hello from TredMail",
    "html": "<p>It works.</p>"
  }'`}
      />
      <P>The response is the email's id and status. Open the email in the console to watch it move from queued to delivered.</P>
      <Code
        title="200 OK"
        code={`{
  "id": "cmvgkysyx0009ixtdd4hv89d7",
  "from": "onboarding@tredmail.dovepeakdigital.com",
  "to": ["you@your-company.com"],
  "status": "queued",
  "scheduled_at": null,
  "created_at": "2026-10-20T11:48:08.163Z"
}`}
      />

      <H2>3. Verify your own domain</H2>
      <P>
        To send from your own address (and to anyone), add the domain under <Link href="/domains" className="font-semibold underline">Domains</Link>, publish the four DNS
        records it shows, and press Verify. The <Link href="/docs/domains" className="font-semibold underline">domains guide</Link> explains each record.
      </P>

      <H2>4. Use an SDK, or SMTP</H2>
      <Code
        title="Node.js"
        code={`import { TredMail } from "@dovepeak/tredmail";

const tredmail = new TredMail({ apiKey: process.env.TREDMAIL_API_KEY! });

const { data, error } = await tredmail.emails.send({
  from: "Dovepeak Billing <billing@your-domain.com>",
  to: "customer@example.com",
  subject: "Your receipt",
  html: "<p>Thank you for your payment.</p>",
});
if (error) console.error(error.message);`}
      />
      <P>
        Python, and how to install both, are on the <Link href="/docs/sdks" className="font-semibold underline">SDKs</Link> page. Applications that can only send with SMTP
        use the <Link href="/docs/smtp" className="font-semibold underline">SMTP relay</Link>.
      </P>

      <H2>What happens to an email</H2>
      <List
        items={[
          <><strong>queued</strong> (or <strong>scheduled</strong>): accepted by the API.</>,
          <><strong>sent</strong>: signed with your domain&apos;s DKIM key and handed to TredMail&apos;s mail server.</>,
          <><strong>delivered</strong>: the recipient&apos;s server accepted it. Temporary refusals show as <strong>deferred</strong> events and are retried for 72 hours.</>,
          <><strong>bounced</strong>, <strong>failed</strong> or <strong>complained</strong>: see the email&apos;s timeline for the reason. Unknown addresses and spam complaints are suppressed automatically.</>,
        ]}
      />
      <Note>
        Get these changes pushed to your application with <Link href="/docs/webhooks" className="font-semibold underline">webhooks</Link> instead of polling.
      </Note>
    </>
  );
}
