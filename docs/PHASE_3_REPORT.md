# Phase 3 report: developer product

**Status:** the code is complete and tested on a development machine.

The phase gate (G2) is "every Dovepeak system migrated; paid providers cancelled". That part
is yours: the checklist below and the migration guide (console `/docs/migrate`) cover it.

## What Phase 3 adds

| Area | What it does | Where |
| --- | --- | --- |
| Templates | Reusable subject, HTML and text with `{{name}}` (escaped), `{{{raw}}}` and `{{name\|fallback}}`. Send with `template` + `variables`. A send with a missing variable is refused instead of going out blank. | `core/mail/template-engine.ts`, `api/routes/templates.ts` |
| Scheduling | `scheduled_at` up to 30 days ahead; cancel (`POST /emails/{id}/cancel`) and reschedule (`PATCH /emails/{id}`). New statuses: `scheduled` and `canceled`. | `core/services/email-service.ts` |
| Idempotency | `Idempotency-Key` on single and batch sends (24 hours). A retry returns the original email; reusing a key with a different body is refused. | `api/idempotency.ts` |
| Reliable queue (outbox) | Emails and attachments live in Postgres; queue jobs carry only ids. Every minute the worker re-queues any due email or webhook delivery that Redis lost. | `worker/monitor.ts` (`sweepOutbox`) |
| Email log | Filters for several statuses, time period, domain, tag, template and email id. Detail view shows the send time, template, attachments and cancel/send-now buttons. | API and console |
| Webhooks v2 | Queued delivery, retried for about 27 hours with the same `webhook-id`. Delivery log with your endpoint's response, replay one or all failed, pause/resume, secret rotation. New events: `email.queued`, `email.scheduled`, `email.canceled`. | `core/webhooks/dispatcher.ts`, `worker/webhooks.ts` |
| SMTP relay | `smtp.tredmail.dovepeakdigital.com` on 587 (STARTTLS) and 465 (TLS); password = API key. See the details after this table. | `apps/smtp-relay` |
| Real certificates and MTA-STS | Caddy obtains certificates for `mta1` and `smtp`; `scripts/cert-sync.sh` (cron) gives them to KumoMTA and the relay. MTA-STS policies are served for both mail domains. | `Caddyfile`, `scripts/cert-sync.sh`, `mta/policy/init.lua` |
| DMARC reports | Aggregate reports mailed to `dmarc@` (gzip, zip or XML) are parsed and stored per domain. The domain page shows the pass rate and sending IPs. | `core/mail/dmarc-report.ts`, `GET /domains/{id}/dmarc` |
| Staging real delivery | Optional allowlist (`STAGING_DELIVERY_ALLOWLIST`) whose mail goes through a private staging KumoMTA. Everything else stays in Mailpit. | worker, `docker-compose.prod.yml` (`staging-delivery` profile) |
| Domain wizard | Three steps (records with relative host names and DNS-provider tips, verify with auto re-check, test send), the DMARC panel, and delete. | console `domains/[id]` |
| Analytics | Delivered-per-day chart (hover and table view, 7/30/90 days) and per-domain rates. | `GET /stats/timeseries`, `GET /stats/domains`, Overview |
| OpenAPI and docs | OpenAPI 3.1 at `GET /v1/openapi.json`. A test fails if a public route is undocumented or the console's copy is stale. Public docs at `/docs`. | `core/openapi/spec.ts`, console `(docs)` |
| SDKs | Node.js (`@dovepeak/tredmail`: ESM/CJS/types, `{ data, error }`, `verifyWebhook`) and Python (`tredmail`: standard library only, `verify_webhook`). Both cover the whole API. | `packages/sdk-node`, `packages/sdk-python` |
| Small fixes | 429 responses use TredMail's error shape (`rate_limit_exceeded`). Suggested DMARC starts at `p=none`, matching the guide. A `templates:manage` scope was added (Developers get it). | |

**SMTP relay details:**
- Envelope recipients decide delivery; envelope-only recipients become Bcc.
- A Bcc-only message is split per recipient, so no recipient sees the others.
- Inline `cid:` images and custom `X-` headers are kept.
- `X-TredMail-Tags`, tracking and schedule settings can be passed as headers.
- A client retry with the same Message-ID is accepted only once.
- Temporary errors get 4xx replies (so clients retry); permanent ones get 5xx.
- 10 failed logins from one address lock it out for 15 minutes.

**The docs at `/docs`:**
- quickstart;
- sending;
- templates;
- webhooks, with signature checks in Node and Python;
- SMTP, with Laravel and Django settings;
- domains and DNS;
- SDKs;
- migrating from Resend, Postmark or SendGrid;
- a full API reference.

## Verification

- **Code checks:** typecheck is clean and lint has 0 errors (the 8 warnings are older `any`s). All 76 unit tests pass, 20 of them new:
  - template engine, staging allowlist and DMARC gzip/zip parsing;
  - webhook retry schedule and DNS host names;
  - OpenAPI coverage and sync;
  - SMTP message conversion;
  - the Node SDK.
- **Python SDK:** 4 tests pass.
- **Console:** builds.
- **Migrations:** they apply cleanly and `prisma migrate diff` shows no difference from the schema.
- **New end-to-end test** (`npm run test:developer`), against the real API, worker, relay and KumoMTA. Everything passed:
  - templates: preview, missing variables, raw HTML and fallbacks;
  - idempotency: retry, reused key, only one email sent;
  - scheduling: reschedule, cancel (never sent), and an 8-second schedule sent on time;
  - filtered list by status and tag;
  - SMTP relay: wrong key refused, Bcc, tags, custom header, inline image, DKIM signature, duplicate Message-ID;
  - outbox: rebuilding a scheduled email after its Redis job was deleted;
  - DMARC: a gzip report via `dmarc@` stored and summarised;
  - webhooks: a failed attempt retried with the same `webhook-id`, the SDK verifying the signature, replay, pause;
  - analytics and the OpenAPI endpoint.
- **Regression:** the Phase 1 and 2 tests still pass (`test:smoke`, `test:accounts`, `test:delivery`).
- **Hand checks:**
  - KumoMTA serves a certificate from a file, and needs a restart to pick up a new one; `cert-sync.sh` restarts it only when the certificate changes.
  - Caddy renders the MTA-STS policy correctly for both domains.
  - The rate limit returns the documented 429.
- **Screenshots** (headless Edge): Overview analytics, the domain wizard with DMARC panel, the template editor with live preview, the quickstart and the API reference.

## What you need to do

1. **Namecheap:** add records 14 to 19 from `docs/PRODUCTION_INFRASTRUCTURE.md`: `smtp`, two `mta-sts` A records, two `_mta-sts` TXT records, and the `*._report._dmarc` TXT record. Add the two `_mta-sts` TXT records only after step 3.
2. **Hostinger:** the support request now also asks for inbound ports 587 and 465 (guide, section 2).
3. **Deploy:** run `deploy-hostinger.sh` as before. It also opens 587/465, starts the relay, copies certificates and installs the `cert-sync` cron job. Then check that KumoMTA shows its real certificate (command in the guide), and add the `_mta-sts` records.
4. **After two weeks of clean TLS reports:**
   - set `MTA_STS_MODE=enforce`;
   - restart Caddy;
   - change the `id=` in both `_mta-sts` records.
5. **Migrate the Dovepeak applications** one at a time, following `/docs/migrate`:
   - verify each sending domain first;
   - give each app its own API key;
   - move templates and webhooks;
   - copy the old providers' suppression lists.
6. **Cancel Resend, Postmark and SendGrid** after a week of clean sending. That completes gate G2.
7. **Optional, staging:** set `STAGING_DELIVERY_ALLOWLIST` (for example `@dovepeakdigital.com`) in `.env.staging` to receive real staging mail.

## Limits and what comes next

| Item | Note |
| --- | --- |
| SDK publishing | Both SDKs build, but are marked private and not published to npm or PyPI. Publishing is your decision (account, package name). Until then, install from the repository as `/docs/sdks` describes. |
| Staging and production on one server | Both stacks run Caddy on ports 80 and 443, so they can't run at the same time on one VPS. This was already the case in Phase 1. Run staging on another host, or only briefly, with production's Caddy stopped. |
| Webhook endpoints that keep failing | Not paused automatically. The console shows failures from the last 7 days per endpoint. Auto-pause plus an email to the owner fits Phase 4's abuse controls. |
| Template logic | No conditions or loops, by design. Prepare values in the application. |
| Attachments | Stored in Postgres, which is fine at Dovepeak's volumes. Move to object storage before SaaS scale (Phase 4). |
| Backup-provider events | Mail sent through the fallback relay stays SENT (from Phase 2). |

## Notes

- **Your dev processes, paused twice:** to regenerate the Prisma client for the two new migrations, I briefly stopped your running dev API and worker. Windows locks Prisma's engine file while they run. Your `tsx watch` processes restarted them; both are running now, as is your console on 3010.
- **Isolated test stack:** the end-to-end tests ran on a separate API (port 3002), relay (2587) and Redis database 1, so your dev worker didn't take their jobs. I then cleared Redis database 1 and pointed local KumoMTA back at port 3000.
- **Local test data:** the dev database now holds test emails, templates and DMARC reports from these runs. `npm run db:seed` doesn't remove them; that's harmless.
- **Open items from earlier phases:** ask GitHub Support to purge the leaked key, and delete the stale branches.
