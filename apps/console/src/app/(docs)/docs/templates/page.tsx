import type { Metadata } from "next";
import Link from "next/link";
import { C, Code, DefTable, DocTitle, H2, Note, P } from "@/components/docs";

export const metadata: Metadata = { title: "Templates" };

export default function TemplatesDocsPage() {
  return (
    <>
      <DocTitle
        title="Templates"
        lead="Keep subjects and bodies in TredMail and send them by alias, so wording changes never need a deploy of your application."
      />

      <H2>Create one</H2>
      <P>
        In the console under <Link href="/templates" className="font-semibold underline">Templates</Link> (with a live preview), or with <C>POST /templates</C>:
      </P>
      <Code
        title="POST /templates"
        code={`{
  "name": "Password reset",
  "alias": "password-reset",
  "from": "Dovepeak <security@your-domain.com>",
  "subject": "Reset your {{product|Dovepeak}} password",
  "html": "<p>Hi {{name}},</p><p><a href=\\"{{{reset_url}}}\\">Choose a new password</a>. The link expires in {{minutes|30}} minutes.</p>",
  "text": "Hi {{name}}, choose a new password: {{{reset_url}}}"
}`}
      />

      <H2>Variables</H2>
      <DefTable
        head={["Syntax", "Result"]}
        rows={[
          [<C key="1">{"{{name}}"}</C>, "The value, HTML-escaped in the HTML body (safe for anything a user typed)."],
          [<C key="2">{"{{{reset_url}}}"}</C>, "The value inserted as-is. Use only for trusted HTML or URLs you built."],
          [<C key="3">{"{{plan|Free}}"}</C>, "A fallback when the variable is missing or empty."],
          [<C key="4">{"{{user.first_name}}"}</C>, "A dotted path into a nested object."],
        ]}
      />
      <P>
        A send that leaves a variable without a value or a fallback is refused with <C>missing_template_variables</C>, so no email goes out with a blank where a name should
        be. There is deliberately no logic (no conditions or loops): prepare values in your application.
      </P>

      <H2>Send with a template</H2>
      <Code
        title="POST /emails"
        code={`{
  "to": "amina@example.com",
  "template": "password-reset",
  "variables": { "name": "Amina", "reset_url": "https://app.example.com/reset?token=..." },
  "track_clicks": false
}`}
      />
      <P>
        Fields in the request win over the template&apos;s: give <C>subject</C> or <C>from</C> to override them for one send. The email records which template it used, and the
        email list can filter by template.
      </P>
      <Note>
        Preview with sample values, without sending: <C>{"POST /templates/{alias}/preview"}</C> with <C>{'{ "variables": { ... } }'}</C>.
      </Note>
    </>
  );
}
