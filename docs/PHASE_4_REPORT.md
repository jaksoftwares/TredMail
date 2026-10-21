# Phase 4 report: SaaS and billing

**Status:** the code is complete and verified on a development machine. Before the first
outside customer pays, finish the production steps below. The full operating guide is
`docs/BILLING_AND_PAYMENTS.md`.

## What Phase 4 adds

| Area | What it does |
| --- | --- |
| Plans | Free, Pro, Scale, plus Enterprise and Internal (both hidden), priced in KES. Monthly or yearly billing. Staff can edit them in the back-office. |
| Limits | Emails per month and per day, domains and members per plan, enforced on every send path (API, batch, SMTP relay). Overage billed per 1,000 emails on Pro and Scale. Email logs are kept for the plan's number of days. |
| Subscriptions | Upgrades are charged immediately, less a credit for unused days. Downgrades and cancellations apply at the end of the paid period. Renewals are invoiced 3 days ahead. An unpaid renewal is followed by 7 days' grace and reminders, then a move to Free. |
| Invoices | Sequential numbers (INV2600001). The seller's and customer's details and KRA PINs are frozen when the invoice is issued, with optional VAT. Invoices are printable and can be saved as PDF. |
| Payments | M-Pesa Express (a PIN prompt) from the console, plus automatic prompts for renewals. Paybill and Till notifications. A reconciler checks payments whose callback never arrived. Money paid beyond the amount due becomes account credit. |
| Gateway-independent | Billing uses a `PaymentGateway` interface. M-Pesa is one adapter; cards or other wallets can be added without changing billing code. |
| Emails | Invoice, receipt, failed payment, overdue, plan change and usage warnings (80% and 100%), in the Dovepeak brand. |
| Console | A Billing page (plan picker, usage, invoices, payments, billing details, pay dialog), an invoice page, a usage card on Overview, and a banner when the workspace is suspended, paused or overdue. |
| Back-office (staff) | Revenue figures and workspace search. Custom plans, manual payments and invoices, voids, refunds and credit. Suspend or resume a workspace. Assign unmatched payments. Edit plans. The gateway log. |
| Abuse controls | A per-workspace circuit breaker (above 4% hard bounces or 0.08% complaints) and suspension by staff. |
| API and SDKs | `GET /v1/usage` and `GET /v1/plans` (documented in OpenAPI), in the Node and Python SDKs. |

## Verification

- Typecheck is clean. Lint has 0 errors.
- All 95 unit tests pass, including 18 new billing tests. They cover periods and proration,
  totals and tax, overage, phone numbers, and the M-Pesa adapter against a fake Daraja (STK
  push, a spoofed callback rejected by the query check, Paybill and Till parsing).
- The console production build compiles.
- The migration applies cleanly, with no drift from the schema.
- **End to end against the Daraja simulator:**
  - Setup: the real API on a separate port, dummy credentials, and real callbacks over HTTP.
  - An upgrade checkout was paid by STK push, and the plan changed to Pro.
  - A cancelled prompt was recorded as failed, with a readable reason.
  - A Paybill payment was matched to its invoice.
  - The test data was removed afterwards.
- **Not tested:** live Daraja. It needs your production credentials and a public HTTPS URL, so
  it is the first item below.

## What you need to do

1. **Deploy as before** (`deploy-hostinger.sh`). The migration creates the plans and puts every
   existing workspace on Free, or Internal for Dovepeak's own workspaces. The script then
   registers the M-Pesa notification URLs.
2. **M-Pesa variables in the server's `.env`.** You use Buy Goods, so:
   - set `MPESA_SHORTCODE` to the **store (head office) number**, which the passkey belongs to;
   - set `MPESA_PARTY_B` to the **till number**;
   - leave `MPESA_CALLBACK_URL` **empty**: TredMail then uses
     `https://api.tredmail.dovepeakdigital.com` with its own secret paths. A value such as
     "to be confirmed" is ignored safely.
3. **Remove the production M-Pesa keys from your local `.env`.** In development they would
   send real PIN prompts, with a localhost callback that Safaricom cannot reach. Locally, use
   `npm run payments:simulator` (see the guide).
4. **First live payment.** Upgrade a test workspace to Pro from the console. Pay with your own
   phone, then check Back-office, Gateway log, and the receipt email. Refund it in the M-Pesa
   portal and press "Record refund".
5. **Optional settings.**
   - `BILLING_TAX_RATE=16` and `BILLING_TAX_ID=<Dovepeak KRA PIN>` once Dovepeak is
     VAT-registered.
   - `BILLING_SUPPORT_EMAIL`.
   - Review the plan prices in Back-office, Plans.
6. **Staff access.** The seeded admin is already staff. Add others with `staff grant <email>`.
   Each staff member must turn on two-factor authentication.

## Limits and notes

| Item | Note |
| --- | --- |
| Buy Goods payments started by the customer | M-Pesa sends no account number for till payments, so payments customers start themselves arrive as Unmatched. Staff assign them in one click. Console prompts are matched automatically. A Paybill number removes this step (see the guide). |
| Refunds | Recorded in TredMail after you return the money in the M-Pesa portal. The reversal API is not called. |
| Card payments | Not included. Adding a card gateway is a new adapter, nothing more. |
| Local dev ports | Port 3000 on this machine now serves another Next.js app, not the TredMail dev API. I left it alone; restart `npm run dev:all` when you work on TredMail. |
