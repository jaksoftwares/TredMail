import type { Metadata } from "next";
import { C, Code, DocTitle, H2, List, Note, P } from "@/components/docs";

export const metadata: Metadata = { title: "SDKs" };

export default function SdksPage() {
  return (
    <>
      <DocTitle title="SDKs" lead="Official libraries for Node.js and Python. Both cover the whole API and verify webhook signatures." />

      <H2>Node.js</H2>
      <P>
        Node.js 18 or later, TypeScript types included, ES module and CommonJS builds. Until the package is published to npm, build it in the TredMail repository (
        <C>packages/sdk-node</C>) and install it from there:
      </P>
      <Code
        title="Install"
        code={`npm run build -w @dovepeak/tredmail                # in the TredMail repository
npm install /path/to/TredMail/packages/sdk-node    # in your application`}
      />
      <Code
        title="Usage"
        code={`import { TredMail } from "@dovepeak/tredmail";

const tredmail = new TredMail({ apiKey: process.env.TREDMAIL_API_KEY! });

// Send, safe to retry thanks to the idempotency key
const { data, error } = await tredmail.emails.send(
  { to: "amina@example.com", template: "password-reset", variables: { name: "Amina", reset_url } },
  { idempotencyKey: \`reset-\${tokenId}\` },
);

// Schedule, then cancel
const later = await tredmail.emails.send({ from, to, subject, html, scheduledAt: new Date(Date.now() + 86_400_000) });
await tredmail.emails.cancel(later.data!.id);

// Find bounced emails from the last week
const bounced = await tredmail.emails.list({ status: ["bounced", "failed"], after: new Date(Date.now() - 7 * 86_400_000) });`}
      />
      <List
        items={[
          <>Every method returns <C>{"{ data, error }"}</C> and never throws for API errors: check <C>error</C>.</>,
          <>Send options are camelCase (<C>replyTo</C>, <C>scheduledAt</C>, <C>trackOpens</C>); responses keep the API&apos;s snake_case.</>,
          <>Resources: <C>emails</C>, <C>templates</C>, <C>domains</C>, <C>webhooks</C>, <C>suppressions</C>, <C>apiKeys</C>, <C>stats</C>.</>,
        ]}
      />

      <H2>Python</H2>
      <P>Python 3.9 or later, standard library only. Install from the repository&apos;s <C>packages/sdk-python</C>:</P>
      <Code title="Install" code={`pip install /path/to/TredMail/packages/sdk-python`} />
      <Code
        title="Usage"
        code={`import os
from tredmail import TredMail, TredMailError

client = TredMail(api_key=os.environ["TREDMAIL_API_KEY"])

try:
    email = client.emails.send(
        {
            "from": "Dovepeak <billing@your-domain.com>",
            "to": "customer@example.com",
            "subject": "Your receipt",
            "html": "<p>Thank you.</p>",
            "attachments": [{"filename": "receipt.pdf", "content": pdf_bytes}],
        },
        idempotency_key=f"receipt-{order.id}",
    )
except TredMailError as err:
    log.warning("TredMail refused the email: %s (%s)", err.code, err.message)`}
      />
      <List
        items={[
          <>Request bodies use the API&apos;s field names. Errors raise <C>TredMailError</C> with <C>status_code</C>, <C>code</C> and <C>message</C>.</>,
          <>Attachment <C>content</C> may be bytes; it is base64-encoded for you. Dates may be <C>datetime</C> objects.</>,
        ]}
      />
      <Note>Any other language works with plain HTTPS and JSON: see the API reference, or download the OpenAPI file from it to generate a client.</Note>
    </>
  );
}
