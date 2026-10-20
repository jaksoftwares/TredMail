"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Smartphone, XCircle } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { money, type GatewayChoice, type InvoiceSummary, type OfflineInstructions, type Payment } from "@/lib/billing";
import { Alert, Button, CopyButton, Dialog, Field, Input } from "@/components/ui";

type Stage =
  | { kind: "form"; error?: string }
  | { kind: "waiting"; payment: Payment; message: string }
  | { kind: "succeeded"; payment: Payment }
  | { kind: "failed"; message: string }
  | { kind: "timeout"; payment: Payment };

const POLL_MS = 2000;
const WAIT_MS = 120_000;

/** 254712345678 -> 0712345678 for the phone field. */
const localPhone = (phone: string | null) => (phone && phone.startsWith("254") ? `0${phone.slice(3)}` : (phone ?? ""));

export function PaybillDetails({ offline }: { offline: OfflineInstructions }) {
  return (
    <div className="rounded-md border border-line bg-offwhite p-4 text-sm">
      <p className="mb-2 font-bold text-navy">{offline.title}</p>
      <dl className="mb-3 grid gap-2">
        {offline.fields.map((f) => (
          <div key={f.label} className="flex items-center justify-between gap-3">
            <dt className="text-muted">{f.label}</dt>
            <dd className="flex items-center gap-2 font-mono font-bold text-navy">
              {f.value}
              {f.label !== "Amount" && <CopyButton value={f.value} label="Copy" />}
            </dd>
          </div>
        ))}
      </dl>
      <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted">
        {offline.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Pays an invoice with a customer gateway. For M-Pesa this sends a PIN prompt to the phone and
 * waits for the result; Paybill details are offered as the alternative.
 */
export function PayInvoiceDialog({
  open,
  onClose,
  invoice,
  gateways,
  offline,
  defaultPhone,
  onPaid,
}: {
  open: boolean;
  onClose: () => void;
  invoice: Pick<InvoiceSummary, "id" | "number" | "amount_due" | "currency">;
  gateways: GatewayChoice[];
  offline: OfflineInstructions | null;
  defaultPhone: string | null;
  onPaid: () => void;
}) {
  const gateway = gateways[0];
  const [values, setValues] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setStage({ kind: "form" });
    setValues({ phone: localPhone(defaultPhone) });
  }, [open, defaultPhone]);

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
  }, []);

  function stopPolling() {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }

  function poll(paymentId: string, startedAt: number) {
    pollRef.current = setTimeout(async () => {
      try {
        const { payment } = await api<{ payment: Payment }>(`/v1/billing/payments/${paymentId}`);
        if (payment.status === "succeeded") {
          setStage({ kind: "succeeded", payment });
          onPaid();
          return;
        }
        if (payment.status === "failed") {
          setStage({ kind: "failed", message: payment.failure_message ?? "The payment was not completed." });
          return;
        }
        if (Date.now() - startedAt > WAIT_MS) {
          setStage({ kind: "timeout", payment });
          return;
        }
      } catch {
        // a network blip: keep polling
      }
      poll(paymentId, startedAt);
    }, POLL_MS);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!gateway) return;
    setSubmitting(true);
    try {
      const result = await api<{ payment: Payment; next_action: { type: string; message?: string; url?: string } | null }>(
        `/v1/billing/invoices/${invoice.id}/pay`,
        { method: "POST", body: { gateway: gateway.id, payer: values } },
      );
      if (result.payment.status === "failed") {
        setStage({ kind: "form", error: result.payment.failure_message ?? "The payment could not be started." });
      } else if (result.payment.status === "succeeded") {
        setStage({ kind: "succeeded", payment: result.payment });
        onPaid();
      } else if (result.next_action?.type === "redirect" && result.next_action.url) {
        window.location.assign(result.next_action.url);
      } else {
        setStage({ kind: "waiting", payment: result.payment, message: result.next_action?.message ?? "Approve the payment on your phone." });
        poll(result.payment.id, Date.now());
      }
    } catch (err) {
      setStage({ kind: "form", error: errorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    stopPolling();
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} title={`Pay ${money(invoice.amount_due, invoice.currency)}`}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Invoice <span className="font-mono font-semibold text-navy">{invoice.number}</span>
        </p>

        {stage.kind === "form" && gateway && (
          <form onSubmit={submit} className="space-y-4">
            {stage.error && <Alert tone="danger">{stage.error}</Alert>}
            {gateway.fields.map((f) => (
              <Field key={f.name} label={f.label} hint={f.hint ?? undefined}>
                <Input
                  type={f.type}
                  required
                  autoComplete={f.type === "tel" ? "tel" : undefined}
                  inputMode={f.type === "tel" ? "tel" : undefined}
                  placeholder={f.placeholder ?? undefined}
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              </Field>
            ))}
            <Button type="submit" loading={submitting} className="w-full">
              <Smartphone className="size-4" />
              Pay with {gateway.name}
            </Button>
          </form>
        )}

        {stage.kind === "form" && !gateway && !offline && (
          <Alert tone="warning">Online payment is not available yet. Contact Dovepeak Technologies to pay this invoice.</Alert>
        )}

        {stage.kind === "waiting" && (
          <div className="flex flex-col items-center gap-3 py-4 text-center" role="status" aria-live="polite">
            <span className="size-10 animate-spin rounded-full border-4 border-navy/10 border-t-orange" aria-hidden />
            <p className="font-semibold text-navy">{stage.message}</p>
            <p className="text-xs text-subtle">This page updates by itself once you approve. The prompt expires after about a minute.</p>
          </div>
        )}

        {stage.kind === "succeeded" && (
          <div className="flex flex-col items-center gap-2 py-4 text-center" role="status">
            <CheckCircle2 className="size-10 text-green" />
            <p className="font-bold text-navy">Payment received</p>
            <p className="text-sm text-muted">
              {money(stage.payment.amount, stage.payment.currency)}
              {stage.payment.receipt ? ` · receipt ${stage.payment.receipt}` : ""}. A receipt is on its way by email.
            </p>
            <Button onClick={close} className="mt-2">Done</Button>
          </div>
        )}

        {stage.kind === "failed" && (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-md bg-danger-50 p-3 text-sm text-danger" role="alert">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>{stage.message} Nothing was charged.</span>
            </div>
            <Button onClick={() => setStage({ kind: "form" })} className="w-full">Try again</Button>
          </div>
        )}

        {stage.kind === "timeout" && (
          <div className="space-y-3">
            <Alert tone="warning">
              We have not heard back from {gateway?.name ?? "the payment provider"} yet. If you approved the payment it will appear here within a few minutes; you will also get a receipt by email.
            </Alert>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setStage({ kind: "waiting", payment: stage.payment, message: "Checking the payment again..." });
                  poll(stage.payment.id, Date.now() - WAIT_MS + 30_000);
                }}
              >
                Check again
              </Button>
              <Button className="flex-1" onClick={() => setStage({ kind: "form" })}>Send a new request</Button>
            </div>
          </div>
        )}

        {offline && stage.kind !== "succeeded" && (
          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-xs font-bold uppercase tracking-wide text-subtle">{gateway ? "Or pay by hand" : "How to pay"}</p>
            <PaybillDetails offline={offline} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
