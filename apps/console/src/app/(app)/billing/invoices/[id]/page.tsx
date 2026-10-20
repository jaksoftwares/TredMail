"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi, useWorkspace } from "@/lib/workspace";
import { day, money, PURPOSE_LABEL, type BillingAccount, type Invoice } from "@/lib/billing";
import { ProductLockup } from "@/components/brand";
import { PaybillDetails, PayInvoiceDialog } from "@/components/pay-invoice";
import { Alert, Button, Card, Spinner, StatusBadge } from "@/components/ui";

/** An invoice as a document: printable (Print, or Save as PDF) with a Pay button while open. */
export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useWorkspace();
  const { data: invoice, error, mutate } = useApi<Invoice>(can.viewBilling ? `/v1/billing/invoices/${id}` : null);
  const { data: overview } = useApi<{ account: BillingAccount }>(can.viewBilling ? "/v1/billing" : null);
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!can.viewBilling) return <Alert tone="warning">Invoices are visible to workspace Owners and Admins.</Alert>;
  if (error) return <Alert tone="danger">{errorMessage(error)}</Alert>;
  if (!invoice) return <Spinner />;

  const d = invoice.billing_details;
  const open = invoice.status === "open" && invoice.amount_due > 0;
  const succeeded = invoice.payments.filter((p) => p.status === "succeeded" || p.status === "refunded");

  async function cancelCheckout() {
    try {
      await api(`/v1/billing/invoices/${invoice!.id}/cancel`, { method: "POST" });
      setMessage({ ok: true, text: "The upgrade was canceled. Nothing was charged." });
      await mutate();
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    }
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/billing" className="inline-flex items-center gap-1.5 text-sm font-semibold text-navy hover:underline">
          <ArrowLeft className="size-4" /> Billing
        </Link>
        <div className="flex gap-2">
          {open && invoice.purpose === "plan_change" && can.manageBilling && (
            <Button variant="ghost" onClick={cancelCheckout}>Cancel upgrade</Button>
          )}
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="size-4" /> Print or save PDF
          </Button>
          {open && <Button onClick={() => setPaying(true)}>Pay {money(invoice.amount_due, invoice.currency)}</Button>}
        </div>
      </div>
      {message && <div className="mb-4 print:hidden"><Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert></div>}

      <Card className="mx-auto max-w-3xl p-6 sm:p-10 print:border-0 print:p-0 print:shadow-none">
        <header className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <ProductLockup />
            <p className="mt-3 text-sm font-semibold text-navy">{d.seller.name}</p>
            <p className="max-w-xs text-xs text-muted">{d.seller.address}</p>
            <p className="text-xs text-muted">{d.seller.website.replace(/^https?:\/\//, "")}</p>
            {d.seller.email && <p className="text-xs text-muted">{d.seller.email}</p>}
            {d.seller.taxId && <p className="text-xs text-muted">PIN {d.seller.taxId}</p>}
          </div>
          <div className="sm:text-right">
            <h1 className="text-2xl font-extrabold text-navy">{invoice.status === "paid" ? "Receipt" : "Invoice"}</h1>
            <p className="font-mono text-sm font-semibold">{invoice.number}</p>
            <div className="mt-2"><StatusBadge status={invoice.status} /></div>
            <dl className="mt-3 space-y-0.5 text-xs text-muted">
              <div>Issued {day(invoice.created_at)}</div>
              {invoice.status === "paid" ? <div>Paid {day(invoice.paid_at)}</div> : <div>Due {day(invoice.due_at)}</div>}
              <div>{PURPOSE_LABEL[invoice.purpose]}</div>
            </dl>
          </div>
        </header>

        <section className="mb-8 text-sm">
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-subtle">Billed to</p>
          <p className="font-semibold text-navy">{d.customer.name}</p>
          {d.customer.name !== d.customer.workspace && <p className="text-muted">Workspace: {d.customer.workspace}</p>}
          {d.customer.address.map((line) => <p key={line} className="text-muted">{line}</p>)}
          {d.customer.email && <p className="text-muted">{d.customer.email}</p>}
          {d.customer.taxId && <p className="text-muted">PIN {d.customer.taxId}</p>}
          <p className="text-muted">Account {d.customer.accountCode}</p>
        </section>

        <table className="mb-6 w-full text-sm">
          <thead>
            <tr className="border-b-2 border-navy text-left text-xs uppercase tracking-wide text-subtle">
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty</th>
              <th className="py-2 pr-3 text-right font-semibold">Unit</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {invoice.lines.map((line, i) => (
              <tr key={i}>
                <td className="py-3 pr-3">{line.description}</td>
                <td className="py-3 pr-3 text-right">{line.quantity}</td>
                <td className="py-3 pr-3 text-right">{money(line.unit_amount, invoice.currency)}</td>
                <td className="py-3 text-right font-semibold">{money(line.amount, invoice.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="mb-8 ml-auto max-w-xs space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{money(invoice.subtotal, invoice.currency)}</dd></div>
          {invoice.tax > 0 && (
            <div className="flex justify-between"><dt className="text-muted">{d.taxLabel} ({invoice.tax_rate}%)</dt><dd>{money(invoice.tax, invoice.currency)}</dd></div>
          )}
          <div className="flex justify-between border-t border-line pt-1.5 text-base font-extrabold text-navy"><dt>Total</dt><dd>{money(invoice.total, invoice.currency)}</dd></div>
          {invoice.amount_paid > 0 && <div className="flex justify-between"><dt className="text-muted">Paid</dt><dd>-{money(invoice.amount_paid, invoice.currency)}</dd></div>}
          {invoice.status === "open" && <div className="flex justify-between font-bold text-navy"><dt>Amount due</dt><dd>{money(invoice.amount_due, invoice.currency)}</dd></div>}
        </dl>

        {succeeded.length > 0 && (
          <section className="mb-8 text-sm">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-subtle">Payments</p>
            <ul className="space-y-1">
              {succeeded.map((p) => (
                <li key={p.id} className="flex flex-wrap justify-between gap-2">
                  <span>{day(p.completed_at)} · {p.method_label}{p.receipt ? ` · receipt ${p.receipt}` : ""}{p.status === "refunded" ? " · refunded" : ""}</span>
                  <span className="font-semibold">{money(p.amount, p.currency)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {invoice.notes && <p className="mb-6 whitespace-pre-line text-sm text-muted">{invoice.notes}</p>}
        {open && invoice.pay_offline && <PaybillDetails offline={invoice.pay_offline} />}
        {invoice.status === "void" && <p className="text-sm text-muted">This invoice was canceled on {day(invoice.voided_at)} and is not payable.</p>}

        <footer className="mt-10 border-t border-line pt-4 text-center text-xs text-subtle">
          TredMail by {d.seller.name} · Thank you for your business.
        </footer>
      </Card>

      {paying && (
        <PayInvoiceDialog
          open
          onClose={() => setPaying(false)}
          invoice={invoice}
          gateways={invoice.pay_with}
          offline={invoice.pay_offline}
          defaultPhone={overview?.account.phone ?? null}
          onPaid={() => void mutate()}
        />
      )}
    </>
  );
}
