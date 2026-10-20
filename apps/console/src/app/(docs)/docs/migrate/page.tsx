import type { Metadata } from "next";
import { API_BASE, C, Code, DefTable, DocTitle, H2, List, Note, P, SMTP_HOST } from "@/components/docs";

export const metadata: Metadata = { title: "Moving from Resend, Postmark or SendGrid" };

export default function MigratePage() {
  return (
    <>
      <DocTitle
        title="Moving from Resend, Postmark or SendGrid"
        lead="Most applications move in under an hour: verify the domain in TredMail, swap the credentials, watch the first day of sends, then cancel the old provider."
      />

      <H2>The order that avoids surprises</H2>
      <List
        items={[
          "Add and verify the sending domain in TredMail. Keep the old provider's DNS records for now: two DKIM records and a combined SPF record can live side by side.",
          "Create one API key per application, with only the emails:send permission.",
          "Switch one low-risk application first (internal alerts), then the rest, one at a time.",
          "Recreate webhooks and templates (below), and copy your old provider's suppression list into TredMail, so known-bad addresses stay blocked.",
          "After a week without problems, remove the old provider's DKIM and SPF entries and cancel the subscription.",
        ]}
      />

      <H2>Fastest path: SMTP</H2>
      <P>
        If the application sends through SMTP today (all three providers support it), change only the host and password: <C>{SMTP_HOST}</C>, port 587, user{" "}
        <C>tredmail</C>, password the API key.
      </P>

      <H2>From the Resend API</H2>
      <P>
        TredMail&apos;s send body uses the same field names as Resend (<C>from</C>, <C>to</C>, <C>subject</C>, <C>html</C>, <C>text</C>, <C>reply_to</C>, <C>tags</C>,{" "}
        <C>headers</C>, <C>attachments</C>, <C>scheduled_at</C>). Point the request at TredMail:
      </P>
      <Code
        title="fetch"
        code={`await fetch("${API_BASE}/emails", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.TREDMAIL_API_KEY}\`, "Content-Type": "application/json" },
  body: JSON.stringify({ from, to, subject, html }),
});`}
      />

      <H2>From Postmark or SendGrid</H2>
      <DefTable
        head={["Postmark", "SendGrid", "TredMail"]}
        rows={[
          [<C key="1">From</C>, <C key="2">from.email</C>, <C key="3">from</C>],
          [<C key="4">To</C>, <C key="5">personalizations[].to</C>, <C key="6">to</C>],
          [<C key="7">HtmlBody / TextBody</C>, <C key="8">content[]</C>, <><C>html</C> / <C>text</C></>],
          [<C key="10">TemplateAlias + TemplateModel</C>, <C key="11">template_id + dynamic_template_data</C>, <><C>template</C> + <C>variables</C></>],
          [<C key="13">Tag / Metadata</C>, <C key="14">categories / custom_args</C>, <C key="15">tags</C>],
          [<C key="16">MessageStream</C>, <C key="17">asm group</C>, <>a <C>category</C> tag</>],
        ]}
      />
      <P>
        Templates: copy each template&apos;s subject and body. Postmark&apos;s and SendGrid&apos;s Mustache/Handlebars <C>{"{{variable}}"}</C> placeholders work unchanged;
        loops and conditions do not, so prepare those values in your code.
      </P>

      <H2>Webhooks</H2>
      <DefTable
        head={["Old event", "TredMail event"]}
        rows={[
          ["Delivery / delivered", <C key="1">email.delivered</C>],
          ["Bounce / bounce, dropped", <C key="2">email.bounced</C>],
          ["SpamComplaint / spamreport", <C key="3">email.complained</C>],
          ["Open / open", <C key="4">email.opened</C>],
          ["Click / click", <C key="5">email.clicked</C>],
          ["deferred", <C key="6">email.deferred</C>],
        ]}
      />
      <Note>
        TredMail signs webhooks with the Standard Webhooks format. Replace the old provider&apos;s signature check with the SDK&apos;s <C>verifyWebhook</C> (see Webhooks).
      </Note>
    </>
  );
}
