/**
 * Billing emails (invoices, receipts, reminders, plan and usage notices), in the same
 * branded layout as account emails. Each builds HTML and plain text from one description.
 */
import { layout, type LayoutOptions, type RenderedEmail } from "./templates.js";

function render(subject: string, options: LayoutOptions): RenderedEmail {
  const text = [
    options.heading,
    "",
    ...options.paragraphs.flatMap((p) => [p, ""]),
    ...(options.rows ?? []).map(([label, value]) => `${label}: ${value}`),
    ...(options.rows?.length ? [""] : []),
    ...(options.cta ? [`${options.cta.label}: ${options.cta.url}`, ""] : []),
    ...(options.footnote ? [options.footnote] : []),
  ].join("\n");
  return { subject, html: layout(options), text: text.trim() + "\n" };
}

export interface PaybillDetails {
  fields: Array<{ label: string; value: string }>;
}

const paybillRows = (paybill?: PaybillDetails | null): Array<[string, string]> =>
  paybill ? paybill.fields.map((f): [string, string] => [`M-Pesa ${f.label.toLowerCase()}`, f.value]) : [];

export function invoiceIssuedTemplate(p: {
  workspace: string;
  number: string;
  amount: string;
  dueDate: string;
  description: string;
  url: string;
  paybill?: PaybillDetails | null;
  promptPhone?: string | null;
}): RenderedEmail {
  const paragraphs = [`Invoice ${p.number} for ${p.workspace} is ready: ${p.description}.`];
  if (p.promptPhone) paragraphs.push(`We will send an M-Pesa payment prompt to ${p.promptPhone}. Enter your PIN when it arrives, or pay any time from the console.`);
  else paragraphs.push("Pay from the console with M-Pesa, or with the Paybill details below.");
  return render(`TredMail invoice ${p.number}: ${p.amount} due ${p.dueDate}`, {
    preheader: `${p.amount} due ${p.dueDate}`,
    heading: `Invoice ${p.number}`,
    paragraphs,
    rows: [["Amount due", p.amount], ["Due date", p.dueDate], ...paybillRows(p.paybill)],
    cta: { label: "View and pay invoice", url: p.url },
    footnote: "Your plan stays active while the invoice is open. Questions about billing? Reply to your account manager or contact Dovepeak Technologies.",
  });
}

export function paymentReceiptTemplate(p: {
  workspace: string;
  number: string;
  amount: string;
  method: string;
  receipt: string | null;
  paidAt: string;
  url: string;
  planNote?: string | null;
}): RenderedEmail {
  const paragraphs = [`Thank you. We received ${p.amount} for ${p.workspace}.`];
  if (p.planNote) paragraphs.push(p.planNote);
  return render(`Payment received: ${p.amount} (invoice ${p.number})`, {
    preheader: `Receipt for invoice ${p.number}`,
    heading: "Payment received",
    paragraphs,
    rows: [
      ["Invoice", p.number],
      ["Amount", p.amount],
      ["Paid with", p.method],
      ...(p.receipt ? ([["Receipt number", p.receipt]] as Array<[string, string]>) : []),
      ["Date", p.paidAt],
    ],
    cta: { label: "View receipt", url: p.url },
  });
}

export function paymentRequestFailedTemplate(p: {
  workspace: string;
  number: string;
  amount: string;
  reason: string;
  url: string;
  paybill?: PaybillDetails | null;
}): RenderedEmail {
  return render(`Payment for invoice ${p.number} did not go through`, {
    preheader: p.reason,
    heading: "Your payment did not go through",
    paragraphs: [
      `We sent an M-Pesa payment request for invoice ${p.number} (${p.workspace}), but it was not completed: ${p.reason}`,
      "Nothing was charged. Pay from the console, or with the Paybill details below.",
    ],
    rows: [["Amount due", p.amount], ...paybillRows(p.paybill)],
    cta: { label: "Pay invoice", url: p.url },
  });
}

export function invoiceOverdueTemplate(p: {
  workspace: string;
  number: string;
  amount: string;
  planName: string;
  downgradeDate: string;
  url: string;
  paybill?: PaybillDetails | null;
}): RenderedEmail {
  return render(`Overdue: invoice ${p.number} for ${p.workspace}`, {
    preheader: `Pay by ${p.downgradeDate} to keep the ${p.planName} plan`,
    heading: "Your invoice is overdue",
    paragraphs: [
      `Invoice ${p.number} for ${p.workspace} is unpaid. Sending continues on the ${p.planName} plan until ${p.downgradeDate}; after that the workspace moves to the Free plan and its limits.`,
    ],
    rows: [["Amount due", p.amount], ["Pay by", p.downgradeDate], ...paybillRows(p.paybill)],
    cta: { label: "Pay now", url: p.url },
  });
}

export function planChangedTemplate(p: { workspace: string; heading: string; message: string; url: string }): RenderedEmail {
  return render(`${p.workspace}: ${p.heading}`, {
    preheader: p.message,
    heading: p.heading,
    paragraphs: [p.message],
    cta: { label: "Open billing", url: p.url },
  });
}

export function usageWarningTemplate(p: {
  workspace: string;
  percent: number;
  used: string;
  limit: string;
  planName: string;
  resetDate: string;
  billsExtra: boolean;
  url: string;
}): RenderedEmail {
  const reached = p.percent >= 100;
  const consequence = reached
    ? p.billsExtra
      ? "Extra emails are billed at the end of the month at your plan's rate."
      : "New emails are refused until the allowance resets. Upgrade to keep sending."
    : p.billsExtra
      ? "Emails above the allowance are billed at your plan's rate."
      : "When it runs out, new emails are refused until the allowance resets.";
  return render(`${p.workspace} has used ${p.percent}% of its monthly emails`, {
    preheader: `${p.used} of ${p.limit} emails used`,
    heading: reached ? "Monthly email allowance used up" : `${p.percent}% of your monthly emails used`,
    paragraphs: [`${p.workspace} has sent ${p.used} of the ${p.limit} emails included in the ${p.planName} plan this month. ${consequence}`],
    rows: [["Used", `${p.used} of ${p.limit}`], ["Resets", p.resetDate]],
    cta: { label: reached && !p.billsExtra ? "Upgrade plan" : "View usage", url: p.url },
  });
}

export function sendingPausedTemplate(p: { workspace: string; reason: string; url: string }): RenderedEmail {
  return render(`Sending paused for ${p.workspace}`, {
    preheader: p.reason,
    heading: "Sending is paused",
    paragraphs: [
      `TredMail paused sending for ${p.workspace}: ${p.reason}`,
      "This protects your domain's reputation and other senders on shared infrastructure. Check the bounced and complained emails, clean the recipient list, then reply to this email or contact Dovepeak support to resume.",
    ],
    cta: { label: "Review emails", url: p.url },
  });
}
