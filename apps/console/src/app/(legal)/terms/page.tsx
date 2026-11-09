import type { Metadata } from "next";
import { DocTitle, H2, List, P } from "@/components/docs";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <article className="space-y-2">
      <DocTitle title="Terms of Service" lead="Last updated: [date of publication]" />

      <H2>1. Who we are</H2>
      <P>
        TredMail is an email sending service (API, SMTP relay and console) operated by [legal name of the operating company], registered in
        [country] under [registration number], registered office [address]. In these terms, &quot;we&quot; means that company and &quot;you&quot;
        means the workspace that holds the TredMail account, and the people who sign in for it.
      </P>

      <H2>2. The service and your account</H2>
      <P>
        You can send transactional email through TredMail from domains you verify, using API keys or SMTP credentials. You are responsible for
        your account, your API keys and everyone you invite to your workspace. Keep credentials secret; tell us at [security contact] if they
        are exposed.
      </P>

      <H2>3. Sending approval and limits</H2>
      <P>
        A new commercial workspace can send from its own domains only up to a daily limit until we have reviewed it. We may approve sending
        earlier or later, or decline it, and we may change limits to protect the shared sending infrastructure that all customers use. Sending
        from TredMail&apos;s own sandbox domain is subject to its own limit.
      </P>

      <H2>4. Acceptable use</H2>
      <List
        items={[
          "You may send only email that recipients have agreed to receive, or that is permitted by law and necessary for your service (for example receipts, password resets and account notices).",
          "You must not send unsolicited bulk email, use purchased or scraped address lists, disguise the sender, or forge headers.",
          "You must honour unsubscribe requests and keep suppression lists in place. Do not try to send to addresses that have bounced or complained.",
          "You must comply with the laws that apply to you and to your recipients, including data protection and anti-spam rules.",
          "You must not use the service to send malware, phishing, fraud or content that is illegal in Kenya or in the recipient's country.",
        ]}
      />
      <P>
        We protect the shared sending reputation automatically. When a workspace&apos;s bounce or complaint rate passes our limits, we pause its
        sending, tell the workspace owners, and resume sending once the cause is fixed. We may suspend or terminate a workspace that breaks these
        rules, and we will tell you why unless the law prevents it.
      </P>

      <H2>5. Fees, invoices and payment</H2>
      <P>
        Plans, prices and included volumes are published in the console. Prices are in Kenya shillings (KES) unless stated otherwise. Payment is
        by M-Pesa or other methods we offer, and invoices are issued in the console. Where we are registered for VAT, VAT is added at the
        published rate. Unpaid renewals keep the paid plan for a grace period of [7] days before the workspace moves to the Free plan. Refunds:
        [refund policy].
      </P>

      <H2>6. Your content and our use of it</H2>
      <P>
        You keep your content. You give us the rights we need to store, process and deliver it, and to show it to you in the console. We process
        personal data in your emails on your behalf, as described in the Privacy Policy and the data processing terms below.
      </P>

      <H2>7. Data processing</H2>
      <P>
        For personal data contained in emails you send, including recipient addresses, you act as the controller and we act as the processor. We
        process that data only to deliver, record and report on your email, and on your documented instructions. We use the sub-processors listed
        in the Privacy Policy and tell you before we add one. Message bodies are erased after [30] days and delivery records are kept for up to
        [395] days, unless you choose shorter periods. [Data processing addendum reference, if any.]
      </P>

      <H2>8. Availability</H2>
      <P>
        We work to keep the service available and to deliver mail promptly. [Service levels and service credits, if any, are set out in the
        plan description.] Scheduled maintenance is announced in advance where we can.
      </P>

      <H2>9. Suspension and termination</H2>
      <P>
        You can cancel at any time in the console. We may suspend or terminate for breach of these terms, for non-payment after the grace period,
        or where required by law. On termination you can export your email records for [period] before we delete them.
      </P>

      <H2>10. Liability</H2>
      <P>
        To the extent the law allows, we are not liable for indirect or consequential loss, lost profits or lost data beyond our backups, and our
        total liability is limited to [the fees you paid in the 12 months before the claim]. Nothing in these terms limits liability that cannot
        be limited by law.
      </P>

      <H2>11. Changes</H2>
      <P>
        We may change these terms. For material changes we will tell workspace owners at least [30] days before they take effect.
      </P>

      <H2>12. Governing law and disputes</H2>
      <P>
        These terms are governed by the laws of [Kenya]. The courts of [Nairobi] have jurisdiction, unless we agree otherwise in writing.
      </P>

      <H2>13. Contact</H2>
      <P>
        Questions about these terms: [legal contact email]. Our postal address is [address].
      </P>

    </article>
  );
}
