import type { Metadata } from "next";
import { DocTitle, H2, List, P } from "@/components/docs";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <article className="space-y-2">
      <DocTitle title="Privacy Policy" lead="Last updated: [date of publication]" />

      <P>
        This policy explains how [legal name of the operating company] (&quot;we&quot;, TredMail) handles personal data. It covers the TredMail
        console, API and SMTP relay. Where you send email through TredMail, the rules in section 4 apply to the recipients of that email too.
      </P>

      <H2>1. Who is responsible</H2>
      <P>
        For account and billing data about the people who use TredMail, we are the controller. For personal data in emails that customers send
        through TredMail, the customer is the controller and we process that data on their instructions (see section 4). Contact: [privacy
        contact email]. Our data protection officer, if appointed: [name and contact].
      </P>

      <H2>2. What we collect about account holders</H2>
      <List
        items={[
          "Account details: name, email address, password (stored as a hash), profile image if you use Google sign-in, and two-factor settings.",
          "Workspace details: workspace name, what you send, website, members and their roles, and domains you verify.",
          "Billing details: plan, invoices, and payment records, including the M-Pesa phone number and transaction reference for a payment.",
          "Technical records: sign-in times, IP addresses and browser details for security, and the audit log of changes made in your workspace.",
          "Support requests you send to us.",
        ]}
      />

      <H2>3. How we use it</H2>
      <P>
        To provide and secure the service, to bill for it, to answer your requests, to keep the service working and to meet legal obligations
        (for example tax records). We do not sell personal data, and we do not use account data for advertising.
      </P>

      <H2>4. Email you send and its recipients</H2>
      <P>
        To deliver an email we store its sender, recipients, subject, content and attachments, the delivery events (accepted, delivered,
        bounced, complained, opened, clicked) and the technical details the receiving mail server reports. When open and click tracking is on
        for a message, opening it or clicking a link records the recipient&apos;s IP address and browser details. We flag likely automated
        opens and clicks (for example by security scanners) and leave them out of your statistics.
      </P>
      <P>
        Message content is erased after [30] days by default. Delivery records (without content) are kept for up to [395] days so you can
        report on a full year. You can ask us to erase an email earlier, and you can delete suppressions and records in the console.
      </P>
      <P>
        Suppression lists keep the addresses of recipients who bounced, complained or unsubscribed, so we do not send to them again. That record
        is kept as long as needed to protect your sending reputation and the recipient&apos;s choice.
      </P>

      <H2>5. Who we share it with</H2>
      <List
        items={[
          "Hosting: the servers that run TredMail are hosted with Hostinger.",
          "Operations email: alerts and mail to our operations mailbox are handled by Zoho Mail.",
          "Payments: M-Pesa payments are processed by Safaricom (Daraja). Safaricom handles payment data under its own terms.",
          "Google sign-in, if it is enabled for your workspace: Google processes the sign-in itself.",
          "Backups: encrypted backups are stored off-server with [backup storage provider].",
        ]}
      />
      <P>
        We will tell you before we add a sub-processor that processes customer data, and you can object on reasonable grounds. Where data
        leaves Kenya, we protect it with [transfer safeguards].
      </P>

      <H2>6. Cookies</H2>
      <P>
        The console uses cookies that are needed to sign you in and keep you signed in, and to protect forms against cross-site requests. [Confirm
        the list of cookies before publication; state any analytics or marketing cookies if they are used.]
      </P>

      <H2>7. Security</H2>
      <P>
        Traffic is encrypted in transit with TLS. API keys and passwords are stored as hashes. Keys we must read back (DKIM signing keys and
        webhook secrets) are encrypted at rest. Our staff can open customer workspaces only for support and operations, and the actions they take in a workspace are recorded in its audit log.
      </P>

      <H2>8. Your rights</H2>
      <P>
        Under the Data Protection Act, 2019 of Kenya you can ask us for access to your personal data, correct it, ask us to erase it or restrict
        its use, object to processing, and ask for a copy in a portable form. You can complain to the Office of the Data Protection Commissioner
        (odpc.go.ke). To use these rights, contact [privacy contact email]. If your personal data is in an email a customer sent, please contact
        that customer first; they are the controller.
      </P>

      <H2>9. Children</H2>
      <P>TredMail is for businesses. We do not knowingly collect personal data from children.</P>

      <H2>10. Changes</H2>
      <P>We will post changes here and, for material changes, tell workspace owners before they take effect.</P>
    </article>
  );
}
