# Billing and payments

How TredMail charges for its plans, how M-Pesa is connected, and how staff run billing.

## How it fits together

| Part | Where |
| --- | --- |
| Plans, subscriptions, usage, invoices, payments | `packages/db/prisma/schema.prisma` (migration `20261020160000_phase4_saas_billing`) |
| Billing logic: plan changes, proration, applying payments | `packages/core/src/billing/service.ts` |
| Billing clock: renewals, overage, reminders, downgrades, usage warnings | `packages/core/src/billing/cycle.ts` (the worker runs it every 10 minutes) |
| Payment reconciliation: asks M-Pesa about payments with no answer yet | `reconcilePendingPayments` (the worker runs it every minute) |
| Usage meter and send limits | `packages/core/src/billing/usage.ts`, called by every send path |
| Payment gateways | `packages/core/src/billing/gateways/` |
| Console: Billing, invoices, Back-office | `apps/console/src/app/(app)/billing`, `.../admin` |

**Gateway-independent by design.** Billing only talks to the `PaymentGateway` interface in
`gateways/types.ts`. Invoices, receipts, plan changes and dunning work the same whichever
gateway took the money. To add a provider (cards, Airtel Money, a bank API):

1. Implement `PaymentGateway`: `initiate`, `query`, `handleCallback`, and optionally
   `offlineInstructions` and `setup`.
2. Register it in `gateways/registry.ts`, enabled when its credentials are set.

The console's pay dialog builds its form from the gateway's `payerFields`, and callbacks
arrive at `/v1/payments/callbacks/<slug>/<kind>/<token>`. No other code changes.

## Plans (KES)

These are seeded by the migration. Change them any time in Back-office, Plans; the new prices
apply to invoices issued after the change.

| Plan | Price | Emails | Extra emails | Domains / members | Logs |
| --- | --- | --- | --- | --- | --- |
| Free | 0 | 3,000 a month, 100 a day | stops at the limit | 1 / 3 | 7 days |
| Pro | 2,500 a month or 25,000 a year | 50,000 a month | KES 120 per 1,000, up to 100,000 extra | 10 / 10 | 30 days |
| Scale | 11,500 a month or 115,000 a year | 100,000 a month | KES 100 per 1,000, up to 400,000 extra | unlimited | 60 days |
| Enterprise (hidden) | custom, set by staff | custom | custom | custom | 90 days |
| Internal (hidden) | 0 | unlimited | – | unlimited | 395 days |

Usage counts each recipient (to, cc and bcc) once. Daily caps reset at 00:00 UTC. Yearly plans
get the monthly allowance each month. Sends over a limit are refused with
`429 daily_limit_exceeded` or `429 monthly_quota_exceeded`. Dovepeak's own workspaces are on
Internal, with no limits.

## The customer's view

- **Upgrade.** The customer chooses a plan, sees the price less a credit for unused days, and
  pays with an M-Pesa PIN prompt. The plan switches the moment the payment is confirmed.
- **Downgrade, or move to Free.** Scheduled for the end of the paid period; it can be undone
  until then.
- **Renewal.**
  - The invoice is emailed 3 days before the period ends.
  - If the customer saved a phone number with automatic prompts on, an M-Pesa prompt goes to
    that phone, only between 08:00 and 20:00 Nairobi time.
  - An unpaid renewal keeps the paid plan for 7 days (`BILLING_GRACE_DAYS`), with reminders.
    After that, the workspace moves to Free.
- **Extra emails.** Billed at month end as their own invoice.
- **Notices.** Usage emails go out at 80% and 100% of the allowance.
- **Invoices.** They print or save as PDF from the console, with the customer's KRA PIN when
  given.

## M-Pesa

**Variables** (in `.env`; both naming styles work):

| Variable | Meaning |
| --- | --- |
| `MPESA_ENV` | `sandbox` or `production` |
| `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET` | Daraja app credentials |
| `MPESA_SHORTCODE` | The short code STK push uses. For Buy Goods this is the store (head office) number. |
| `MPESA_PASSKEY` | The Lipa na M-Pesa Online passkey for that short code |
| `MPESA_TRANSACTION_TYPE` | `CustomerBuyGoodsOnline` (Till) or `CustomerPayBillOnline` (Paybill) |
| `MPESA_PARTY_B` | The till number (Buy Goods) or Paybill number that receives the money |
| `MPESA_CALLBACK_URL` | Leave empty. TredMail then uses `https://api.tredmail.dovepeakdigital.com` and builds the paths itself, each with a secret token. If you set it, give an `https://` origin without "mpesa" or "safaricom" in it (Safaricom rejects those). |

**Safety.**
- Daraja callbacks are not signed. TredMail protects them three ways:
  - a secret token in each callback URL;
  - before accepting a success, it re-checks the payment with Daraja's query API
    (`MPESA_VERIFY_CALLBACKS=true`);
  - an optional IP allowlist (`MPESA_ALLOWED_IPS`).
- Every callback is stored, and Back-office, Gateway log shows each one.

**Missed callbacks.** The worker asks Daraja about any payment still pending after a minute.
It gives up after 15 minutes.

**Paying by hand.**
- With a Paybill, customers type the invoice number, or their account code (`TM…`, shown on
  the Billing page), as the account number. The payment is applied automatically.
- With **Buy Goods (Till)**, which is what you configured, M-Pesa sends no account number:
  - the console and emails show the till number and ask the customer to send the
    confirmation SMS;
  - such payments arrive as **Unmatched**, and staff assign them in Back-office, Payments
    (one click);
  - STK prompts from the console are matched automatically, so this applies only to payments
    customers start themselves.
- Getting a Paybill number later removes this manual step. Set `MPESA_TRANSACTION_TYPE=CustomerPayBillOnline`
  and `MPESA_PARTY_B=<paybill>`, then run `payments:setup` again.

**One-time setup (production):** `deploy-hostinger.sh` runs it for you. To run it by hand:

```
docker compose -f docker-compose.prod.yml --env-file .env run --rm --no-deps api node apps/api/dist/cli/payments-setup.js
```

This registers the confirmation and validation URLs for the short code. Safaricom keeps the
first registration for a production short code. To change the URLs later, delete them in the
M-Pesa organisation portal first, or ask Safaricom's API support (apisupport@safaricom.co.ke).

**Local development:**
- Do not use the production credentials locally. Run the simulator with
  `npm run payments:simulator`.
- Set `MPESA_BASE_URL=http://localhost:4010` with any dummy credentials.
- The test phone number decides the outcome:
  - ending 1032: the customer cancels;
  - ending 0001: insufficient balance;
  - ending 9999: the callback is lost (tests reconciliation).

## Staff (Back-office)

Grant access with `npm run staff -- grant you@dovepeakdigital.com`. In production:
`node apps/api/dist/cli/staff.js grant ...` inside the api container. The seeded admin is
already staff. In production, staff must turn on two-factor authentication before the
back-office opens.

The Back-office (sidebar, staff only) does the following:
- **Workspaces:**
  - revenue (MRR, collected, outstanding, overdue);
  - search by name, owner email or account code;
  - per workspace: set any plan with custom price and limits (Enterprise deals), record a bank
    transfer or cash payment, create an invoice by hand, void an invoice, adjust credit, record
    a refund, suspend or unsuspend, and resume sending after the circuit breaker paused it.
- **Payments:** every payment, and an **Unmatched** filter for Till or Paybill money that
  matched no account (assign it to a workspace and invoice).
- **Plans:** edit prices, limits and features, or add plans.
- **Gateway log:** the raw notifications from M-Pesa.
- **Run billing now:** runs the billing clock immediately.

Every staff action is written to the workspace's audit log.

**Refunds.** Return the money in the M-Pesa portal first, then press "Record refund" on the
payment. TredMail does not call M-Pesa's reversal API.

## Abuse controls that came with this phase

- **Circuit breaker.** A customer workspace with more than 4% hard bounces, or more than 0.08%
  spam complaints, over 24 hours is paused automatically. The owners and `OPS_EMAIL` are
  emailed, and staff resume it.
- **Suspension by staff.** A suspended workspace cannot send at all.
- **Plan limits.** Domains and members (pending invitations count as members) are limited by
  the plan.
