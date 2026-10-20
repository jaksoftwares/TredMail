import type { Metadata } from "next";
import { C, Code, DefTable, DocTitle, H2, List, Note, P, SMTP_HOST } from "@/components/docs";

export const metadata: Metadata = { title: "SMTP relay" };

export default function SmtpDocsPage() {
  return (
    <>
      <DocTitle
        title="SMTP relay"
        lead="For WordPress, Laravel, Django, legacy systems and anything else that sends with SMTP: change the SMTP settings, nothing else. The same rules, tracking, webhooks and suppressions apply as for the API."
      />

      <H2>Settings</H2>
      <DefTable
        head={["Setting", "Value"]}
        rows={[
          ["Host", <C key="h">{SMTP_HOST}</C>],
          ["Port", <><C>587</C> with STARTTLS (recommended), or <C>465</C> with TLS</>],
          ["Username", <><C>tredmail</C> (any value works)</>],
          ["Password", <>An API key with the <C>emails:send</C> permission</>],
        ]}
      />
      <Code
        title="Laravel .env"
        code={`MAIL_MAILER=smtp
MAIL_HOST=${SMTP_HOST}
MAIL_PORT=587
MAIL_USERNAME=tredmail
MAIL_PASSWORD=tred_live_...
MAIL_ENCRYPTION=tls
MAIL_FROM_ADDRESS=hello@your-domain.com`}
      />
      <Code
        title="Django settings.py"
        code={`EMAIL_HOST = "${SMTP_HOST}"
EMAIL_PORT = 587
EMAIL_USE_TLS = True
EMAIL_HOST_USER = "tredmail"
EMAIL_HOST_PASSWORD = os.environ["TREDMAIL_API_KEY"]`}
      />

      <H2>How messages are handled</H2>
      <List
        items={[
          "The From address must be on a verified domain of the key's workspace.",
          "Recipients come from the SMTP envelope. Addresses only in the envelope become Bcc; a message with only Bcc recipients is sent separately to each, so nobody sees the others.",
          "A message re-sent with the same Message-ID within 24 hours (a client retrying after a timeout) is accepted once.",
          "Inline images (cid:) and attachments are kept. Messages can be up to 10 MB, with up to 50 recipients.",
          "TredMail replies 250 with the email ids. Temporary problems get a 4xx reply, so your mail library retries; permanent ones (unverified domain, suppressed recipient) get a 5xx reply with the reason.",
        ]}
      />

      <H2>Options as headers</H2>
      <DefTable
        head={["Header", "Effect"]}
        rows={[
          [<C key="1">X-TredMail-Tags: category=receipt, plan=pro</C>, "Tags, as in the API."],
          [<C key="2">X-TredMail-Track-Opens: false</C>, <>Also <C>X-TredMail-Track-Clicks</C>.</>],
          [<C key="3">X-TredMail-Scheduled-At: 2026-11-01T08:00:00Z</C>, "Send later."],
        ]}
      />
      <Note>
        These headers are removed before sending. Other <C>X-</C> headers you set are passed through.
      </Note>
      <P>
        Ten wrong passwords from one address lock it out for 15 minutes. Use a separate API key per application so one can be revoked without touching the others.
      </P>
    </>
  );
}
