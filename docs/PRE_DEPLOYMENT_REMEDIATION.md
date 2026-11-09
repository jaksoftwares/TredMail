# Pre-deployment remediation plan

**Status:** open. **Rule:** TredMail is not deployed to production until every item in this
document is closed and the release gate (section 5) passes.

This plan comes from the production-readiness audit of 29 October 2026. It lists every issue
the audit found, what to change, how to know it is fixed, and the order to fix them in. It is
for the engineers doing the work and for whoever signs off the release.

---

## 1. Where things stand

Automated checks at the time of the audit:

| Check | Result |
| --- | --- |
| Typecheck (backend and console) | clean |
| Lint | 0 errors, 8 `no-explicit-any` warnings |
| Unit tests | 95 of 95 pass |
| Builds (api, worker, smtp-relay, CLI tools, console) | all succeed |
| `npm audit --omit=dev` (backend) | 1 high, 3 moderate (item H6) |
| `npm audit --omit=dev` (console) | none |

The audit reviewed the source. It did not run the Docker stack or deliver real mail through
KumoMTA; live delivery is part of the release gate.

What is already sound and must not regress: the database as source of truth with the outbox
sweeper, idempotency keys, signed tracking URLs, Standard Webhooks signatures with retries,
encrypted DKIM keys, SSRF checks, CSRF protection, staff two-factor, role and scope checks,
the KumoMTA policy (72-hour retries, per-provider shaping, VERP bounces, MTA-STS), and billing
row locks with idempotent receipts.

---

## 2. Severity levels

| Level | Meaning |
| --- | --- |
| **B** (blocker) | Breaks an advertised feature, loses or delays mail, or breaks a mailbox-provider rule. |
| **H** (high) | Real risk of duplicate mail, lost money, security exposure or reputation damage. |
| **M** (medium) | Wrong behaviour in edge cases, or problems that grow with volume. |
| **L** (low) | Polish and consistency. |
| **F** (feature) | Capability customers expect from Resend or Postmark that TredMail lacks. |

All levels are required before deployment.

---

## 3. The issues

Each issue has: the problem, where it is, the fix, and the acceptance check. Item IDs are used
in the implementation order (section 4).

### Blockers

#### B1. `email.opened` and `email.clicked` webhooks never fire
- **Problem:** both events can be subscribed to, but the tracking routes only write an
  `EmailEvent` row and never dispatch a webhook.
- **Where:** `apps/api/src/routes/tracking.ts` (open handler and click handler).
- **Fix:** after recording the event, call `dispatchWebhookEvent(organizationId, "email.opened" | "email.clicked", …)`.
  The tracking route has only the email id, so load `organizationId`, `from`, `to` and
  `subject` with the event insert. Include `ip_address`, `user_agent` and, for clicks,
  `link_url`. Do not fire for events flagged as bot traffic (see H7).
- **Acceptance:** a test that hits a signed open URL and a signed click URL and asserts a
  `webhookDelivery` row with the right event and payload. A webhook subscribed to `*`
  receives both events end to end.

#### B2. Mail is marked failed after about 75 seconds of retries
- **Problem:** the email queue makes 5 attempts with 5-second exponential backoff (5, 10, 20,
  40 seconds). Any KumoMTA outage longer than that, including the restart `cert-sync.sh` does
  every ~60 days, fails every queued email permanently.
- **Where:** `packages/core/src/queue/email.queue.ts` (`defaultJobOptions`).
- **Fix:** retry for at least 6 hours with a capped backoff: a custom backoff strategy
  (as the webhook worker already uses) such as 30 s, 1 min, 2 min, 5 min, 10 min, then every
  15 minutes, about 30 attempts. Distinguish errors: connection and 4xx errors retry; a 5xx
  rejection of the whole message by our own MTA is permanent. Record each failed attempt as
  `DEFERRED` (already done) so customers see progress.
- **Depends on:** H1, because more retries make duplicate sends more likely. Ship together.
- **Acceptance:** with KumoMTA stopped for 10 minutes, queued mail stays `QUEUED`/`SENDING`
  and is sent when it returns. Unit test for the backoff schedule.

#### B3. Account and security emails are held by the warm-up cap
- **Problem:** verification, password-reset, invitation, billing and alert emails go through
  `acceptEmail` like customer mail, so they count against the daily warm-up cap. When
  customers use up the day's allowance, these emails wait until the next UTC day unless a
  fallback relay is configured. Sign-up and password reset stop working.
- **Where:** `packages/core/src/services/system-mailer.ts`, `apps/worker/src/index.ts`
  (`chooseRoute`).
- **Fix:** add a `priority` column to `Email` (`SYSTEM` / `NORMAL`, migration). Set `SYSTEM` in
  `sendSystemEmail`. In the worker, `SYSTEM` mail skips the warm-up reservation (it is low
  volume) and is queued with BullMQ job priority so it never waits behind a customer backlog.
  Do not count system mail against the platform workspace's plan usage.
- **Acceptance:** with the warm-up cap at 0, a password-reset email is still delivered. Test
  in `delivery.test.ts`.

#### B4. Operations alerts are sent through the system they monitor
- **Problem:** health and blocklist alerts are emailed through TredMail's own pipeline. If
  KumoMTA is down, the IP is blocklisted or the platform domain is unverified, the alert about
  it cannot be delivered.
- **Where:** `apps/worker/src/monitor.ts` (`notify`), `packages/core/src/services/circuit-breaker.ts`,
  `packages/core/src/billing/service.ts` (`notifyOps`).
- **Fix:** add an out-of-band alert channel used for every ops alert, in addition to email:
  `ALERT_WEBHOOK_URL` (Slack, Teams or Telegram-compatible JSON post) and, when set, send the
  email through `FALLBACK_SMTP_*` instead of KumoMTA. Add an external uptime monitor (for
  example UptimeRobot or Better Stack) on `https://api…/health/ready` and the console, and
  document it in the runbook. Add a worker heartbeat: the worker writes a timestamp to Redis
  each minute and `/health/ready` reports `worker: down` when it is older than 5 minutes.
- **Acceptance:** with KumoMTA stopped, an alert still reaches the ops channel. The uptime
  monitor is listed in the runbook's go-live checklist.

#### B5. Domains are never verified automatically or re-checked
- **Problem:** DNS is checked only when someone presses Verify. Pending domains are never
  checked automatically (the README promises automated verification). Verified domains are
  never re-checked, so a customer who removes their DKIM record keeps sending mail that fails
  DMARC from our IP.
- **Where:** `apps/api/src/routes/domains.ts` (verify route), `apps/worker/src/monitor.ts`
  (scheduler).
- **Fix:** move the verify logic into a core service (`packages/core/src/dns/domain-check.ts`)
  used by both the route and a new `domain-check` maintenance job:
  - pending domains: check every 5 minutes for the first hour after creation, then hourly
    for 72 hours, then daily;
  - verified domains: check daily.
  A verified domain that fails is marked `DEGRADED` (new status) on the first failure and only
  `FAILED` after failing for 72 hours; email the workspace owners at each step. Record
  `domain.verified` / `domain.degraded` audit entries and add `domain.updated` webhook events.
- **Depends on:** H2 (the worker must not fail mail for a `DEGRADED` domain).
- **Acceptance:** tests with a fake resolver for each transition. A new domain becomes
  verified without anyone pressing Verify.

#### B6. Customers cannot add one-click unsubscribe
- **Problem:** `List-Unsubscribe` and `List-Unsubscribe-Post` are reserved headers and TredMail
  never adds them. Gmail and Yahoo require one-click unsubscribe (RFC 8058) for bulk and
  marketing mail.
- **Where:** `packages/core/src/services/email-validation.ts` (`RESERVED_HEADERS`), worker.
- **Fix:**
  1. Let customers set both headers (remove them from the reserved list, validate the value
     is `<https://…>` and/or `<mailto:…>`).
  2. Add a TredMail-hosted option: send field `unsubscribe: true` (and SMTP header
     `X-TredMail-Unsubscribe: true`). The worker adds
     `List-Unsubscribe: <https://track…/v1/unsubscribe/<id>?sig=…>` and
     `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
  3. New public route `POST|GET /v1/unsubscribe/:emailId` (signed like tracking links) that
     creates an `UNSUBSCRIBE` suppression and fires a new `email.unsubscribed` webhook. GET
     shows a small confirmation page.
  4. Document it in the OpenAPI spec, SDKs and `/docs/sending`.
- **Acceptance:** tests for the signed route, the suppression and the webhook. A message to
  Gmail shows Gmail's native "Unsubscribe" link.

#### B7. The SDKs cannot be installed by customers
- **Problem:** `@dovepeak/tredmail` is `"private": true`; the docs say
  `npm install /path/to/TredMail/packages/sdk-node`. The Python SDK is likewise not on PyPI.
- **Where:** `packages/sdk-node/package.json`, `packages/sdk-python/pyproject.toml`,
  `apps/console/src/app/(docs)/docs/sdks/page.tsx`, both SDK READMEs.
- **Fix:** remove `private`, add a license and repository fields, build `dist` in CI, and add
  a release workflow (`.github/workflows/release-sdks.yml`) that publishes on a tag
  (`sdk-node-v*`, `sdk-python-v*`) with `NPM_TOKEN` and PyPI trusted publishing. Update the
  docs to `npm install @dovepeak/tredmail` and `pip install tredmail`. Point the default base
  URL at the production API.
- **Acceptance:** a clean project installs both packages from the public registries and sends
  a test email.

### High

#### H1. A crash between sending and recording can send an email twice
- **Problem:** the worker calls `sendMail` and only then writes `SENT`. If the process dies or
  the database write fails in between, the retry sends the email again.
- **Where:** `apps/worker/src/index.ts` (`deliver`).
- **Fix:** record a `sendAttemptId` on the email before calling `sendMail`, and pass it as the
  `X-TredMail-Attempt` header. After a successful `sendMail`, write `SENT` with retries. On a
  retry, if the email is `SENDING` with a recorded attempt older than the SMTP timeout, look
  for a KumoMTA reception record for that attempt (KumoMTA logs `Reception` with headers) via
  the events endpoint before resending; if found, mark `SENT` without resending. Keep the
  window small by doing nothing between `sendMail` and the status write except that write.
- **Acceptance:** a test that throws after `sendMail` and asserts the retry does not send
  again.

#### H2. A domain that is briefly unverified fails all its queued mail
- **Problem:** if the domain is not `VERIFIED` when the job runs, the worker throws
  `UnrecoverableError` and the email is `FAILED` with no retry.
- **Where:** `apps/worker/src/index.ts` (domain check in `deliver`).
- **Fix:** `VERIFIED` and `DEGRADED` domains send normally. Any other status delays the job by
  30 minutes (`moveToDelayed`, `DEFERRED` event with reason `domain_not_verified`) for up to 72
  hours, then fails it.
- **Acceptance:** worker test for each domain status.

#### H3. M-Pesa Paybill confirmations are trusted on the URL token alone
- **Problem:** STK results are confirmed with Daraja's query API; Paybill (C2B)
  confirmations are not, and `MPESA_ALLOWED_IPS` is empty by default. Anyone who learns the
  callback URL can mark invoices paid.
- **Where:** `packages/core/src/billing/gateways/mpesa.ts` (`confirm`),
  `packages/core/src/config/env.ts`, `docker-compose.prod.yml`, runbook.
- **Fix:** in production, refuse to start the API when M-Pesa is configured and
  `MPESA_ALLOWED_IPS` is empty (env check). Put Safaricom's published callback IP ranges in
  `.env.example` and the runbook. Add a staff alert when a Paybill payment above a threshold
  is applied, and make sure request URLs (which contain the token) are not logged at `info`.
- **Acceptance:** env test for the new rule; a callback from a non-allowlisted IP gets 403.

#### H4. No vetting of new paying customers on one shared IP
- **Problem:** anyone can sign up, verify a domain and send from Dovepeak's only IP. The
  circuit breaker acts after damage is done (50 attempts, 24-hour window).
- **Where:** `apps/api/src/routes/account.ts`, `packages/core/src/services/email-service.ts`,
  back-office.
- **Fix:** add `Organization.sendingApprovedAt`. New commercial workspaces may send from their
  own domains only up to a small daily limit (for example 100) until staff approve them in the
  back-office. Show the state and a "request review" button in the console; notify staff when
  a review is requested. Also shorten the circuit breaker's first window: check hourly with a
  1-hour window in addition to the 24-hour one.
- **Acceptance:** an unapproved workspace hits `sending_not_approved` above the limit;
  approval lifts it; audit entries are written.

#### H5. Database backups are not automated
- **Problem:** the runbook describes a nightly `pg_dump`, but the deploy script never
  installs it, and off-server copies are manual.
- **Where:** `deploy-hostinger.sh`, new `scripts/backup.sh`, runbook section 6.3.
- **Fix:** `scripts/backup.sh` dumps Postgres (`pg_dump -Fc`), keeps 14 days locally and, when
  `BACKUP_RCLONE_REMOTE` is set, copies the dump off the server with `rclone`. The deploy
  script installs it in `/etc/cron.d/tredmail-backup` and warns when no remote is set. Include
  an encrypted copy of `.env` (it holds `TREDMAIL_MASTER_ENCRYPTION_KEY`). Document and test a
  restore (`scripts/restore.sh`) on staging.
- **Acceptance:** a restore drill on staging from an off-server dump succeeds and DKIM keys
  decrypt.

#### H6. Vulnerable dependencies
- **Problem:** `zod` < 4.6.6 (high: memory exhaustion while validating large collections);
  `nodemailer` address-parser bugs inside `mailparser` and `smtp-server` (moderate), used by
  the SMTP relay and inbound parsing.
- **Fix:** upgrade `zod` to 4.x across all workspaces and migrate the schemas (`.errors` →
  `.issues`, `z.string().email()` → `z.email()`, `z.record` needs a key schema, and so on).
  Upgrade `smtp-server` and `mailparser` to releases that depend on a fixed `nodemailer`. Add
  `npm audit --omit=dev --audit-level=high` to CI so this cannot recur unnoticed.
- **Acceptance:** `npm audit --omit=dev` reports no vulnerabilities; all tests pass.

#### H7. Tracking is on by default and counts bots
- **Problem:** opens and clicks default to on (Resend defaults to off), so every link,
  including customers' password-reset and login links, is rewritten through the tracking
  domain. Security scanners (Microsoft Safe Links, Proofpoint) and Apple Mail Privacy
  Protection create false opens and clicks.
- **Where:** `packages/core/src/services/email-service.ts`, `packages/core/src/mail/mime.ts`,
  `apps/api/src/routes/tracking.ts`.
- **Fix:** default `track_opens` and `track_clicks` to `false`, with a per-workspace default
  setting in the console. Never rewrite links whose text or URL looks like a security action
  unless the caller opted in per email (document this). Flag likely bot events (known scanner
  user agents and IP ranges, clicks within 2 seconds of delivery, Apple proxy opens) with
  `details.bot = true`; exclude them from stats and webhooks.
- **Acceptance:** tests for the new defaults and bot flagging. This is a behaviour change:
  call it out in the changelog and `/docs/sending`.

### Medium

#### M1. The SMTP relay skips request validation
- **Problem:** relay requests go straight to `acceptEmail` without `sendEmailSchema`. A bad
  `X-TredMail-Scheduled-At` header becomes an invalid date, the insert fails, the client gets
  a temporary error and retries forever. The API's limits (attachments, tags, address format)
  are bypassed.
- **Where:** `apps/smtp-relay/src/index.ts` (`handleMessage`), `apps/smtp-relay/src/convert.ts`.
- **Fix:** run each request through `sendEmailSchema.safeParse`; a failure is a permanent
  `554 5.6.0` with the first issue's message. `parseSchedule` in `email-service.ts` also
  rejects invalid dates for every caller.
- **Acceptance:** tests in `convert.test.ts` and a relay test for a bad schedule header.

#### M2. SMTP split messages can be partly dropped without telling the client
- **Problem:** when a Bcc-only message is split per recipient and a later part is refused,
  the client still receives `250`.
- **Fix:** validate every part before accepting any (suppression, domain, quota), then accept
  all. If a later part still fails, return `250` but record a `FAILED` email for it so it is
  visible in the console and fires `email.failed`.
- **Acceptance:** relay test with one suppressed Bcc recipient.

#### M3. SMTP Message-ID de-duplication can lose a message
- **Problem:** while the first submission of a Message-ID is still running, a retry gets
  "Already accepted" with no ids. If the first then fails and deletes its claim, the message
  is lost.
- **Where:** `apps/smtp-relay/src/index.ts` (`claimMessageId`).
- **Fix:** mirror the API's idempotency logic: an unfinished claim younger than 5 minutes
  returns `451 4.3.0` (retry later); only a finished claim is answered as a duplicate.
- **Acceptance:** unit test of the claim states.

#### M4. One suppressed recipient blocks the whole email
- **Problem:** if any recipient is suppressed, the request is refused. Resend drops only the
  suppressed recipient. Suppressions are also checked only when the email is accepted.
- **Where:** `packages/core/src/services/email-service.ts` (`acceptEmail`), worker.
- **Fix:** remove suppressed addresses and send to the rest; refuse only when no recipient is
  left. Return the removed addresses in the response (`suppressed: [...]`). Re-check
  suppressions in the worker just before sending and drop newly suppressed recipients. Only
  count sent recipients against usage.
- **Acceptance:** tests for partial and full suppression, and for a suppression added
  between accept and send.

#### M5. Missing indexes for background jobs
- **Problem:** the health check and circuit breaker scan `email_events` by `type` and
  `timestamp`; the webhook sweeper filters `webhook_deliveries` by `status` and
  `nextAttemptAt`; the outbox sweep filters `emails` by `status` and `updatedAt`. These become
  full scans as volume grows.
- **Where:** `packages/db/prisma/schema.prisma`, new migration.
- **Fix:** add `@@index([type, timestamp])` on `EmailEvent`,
  `@@index([status, nextAttemptAt])` on `WebhookDelivery`, `@@index([status, updatedAt])`
  and `@@index([domainId])` on `Email`. For the `dedupeKey` lookup in delivery events, add a
  nullable `dedupeKey` column with a unique index instead of the JSON path query.
- **Acceptance:** CI's migration drift check passes; `EXPLAIN` on staging uses the indexes.

#### M6. Fake API keys bypass the rate limit
- **Problem:** the limiter keys on a hash of any bearer token, so random tokens each get a new
  bucket and every request still hits the database.
- **Where:** `apps/api/src/app.ts`.
- **Fix:** add a per-IP limit that applies to all requests (for example 1,200/minute) plus a
  stricter per-IP limit on failed authentication (for example 30 failures/minute, then 429),
  reusing the Redis counter pattern from the SMTP relay. Keep the per-key limit for valid keys.
- **Acceptance:** test that 31 bad keys from one IP get 429.

#### M7. Webhook SSRF check can be bypassed by DNS rebinding
- **Problem:** the URL check resolves the host, then `fetch` resolves it again and may get a
  private address.
- **Where:** `packages/core/src/webhooks/dispatcher.ts`, `packages/core/src/security/url-safety.ts`.
- **Fix:** use an `undici` `Agent` with a custom `connect.lookup` that resolves once, rejects
  private addresses, and connects to that exact IP (TLS SNI still uses the hostname).
- **Acceptance:** test with a lookup that returns a public IP first and a private one second.

#### M8. Webhook secrets are stored in plain text
- **Fix:** encrypt `Webhook.secret` with `encryptSecret` (as DKIM keys are), decrypt when
  signing. Migration script encrypts existing rows. **Acceptance:** no plaintext `whsec_` in
  the database; signatures still verify.

#### M9. `tred_test_` keys have no test mode
- **Problem:** the key prefix exists but nothing behaves differently.
- **Fix:** let users create test keys in the console. Emails sent with a test key are
  validated and recorded with `test: true` but never delivered (status goes straight to
  `DELIVERED` with a `test_mode` event), do not count against usage, and fire webhooks with
  `"test": true`. Document in `/docs/sending`.
- **Acceptance:** tests; a test-key email never reaches the transport.

#### M10. The seed resets the admin's role on every deploy
- **Where:** `apps/api/src/cli/seed.ts` (`ensureAdmin`).
- **Fix:** `update: {}` instead of `update: { role: "OWNER" }`; only create the membership.

### Low

- **L1.** Version strings disagree: API `1.4.0` (`apps/api/src/app.ts`), packages `1.2.0`, relay
  and SDKs `1.3.0`. Use one version from the root `package.json` injected at build time.
- **L2.** The console has no Content-Security-Policy. Add one in `apps/console/next.config.ts`
  (`default-src 'self'`, `frame-src 'self'` for the sandboxed previews, `img-src` for brand
  assets) and test every page.
- **L3.** A user can create unlimited workspaces. Limit unapproved users to 3; staff can lift
  it.
- **L4.** Fix the 8 `no-explicit-any` lint warnings and make lint fail on warnings in CI.

### Features expected by customers coming from Resend or Postmark

#### F1. Inbound email for customers
Receive mail for customer domains (MX to `inbound.<platform domain>`), parse it and deliver
it as an `email.received` webhook with attachments, and list it in the console. Builds on the
existing KumoMTA inbound path (`/internal/mta/inbound`) and `inbound-mail.ts`.

#### F2. Contacts, audiences and broadcasts
The README advertises marketing email. Add audiences and contacts (with per-contact
unsubscribe state), a broadcast composer using templates, scheduled broadcasts sent through
the normal pipeline with throttling, and per-broadcast stats. Requires B6 (unsubscribe) and
F4 (separate streams).

#### F3. API keys restricted to one domain
Add optional `domain_ids` to API keys ("sending access" keys); `acceptEmail` refuses senders
outside them.

#### F4. Separate transactional and broadcast streams
Add `Email.stream` (`transactional` / `broadcast`). Broadcast mail uses its own KumoMTA egress
pool and, once available, its own IP, so marketing reputation cannot hurt transactional
delivery. Stats and suppressions can be filtered per stream.

#### F5. More than one sending IP, and no single server
- Add a second IP as a second egress source (the KumoMTA policy is already shaped for it) and
  assign pools per stream.
- Remove the single point of failure: managed or replicated Postgres with point-in-time
  recovery, Redis persistence already on, and a documented procedure (and a tested drill) to
  rebuild on a new server from backups within an agreed recovery time.

---

## 4. Implementation order

The order puts shared foundations first so later work is not redone, keeps changes that touch
the same code in the same phase, and gets the delivery path right before features are built on
it. Each phase ends with `npm run typecheck`, `npm run lint`, `npm test`, the console build and
a staging deploy.

| Phase | Items | Why here |
| --- | --- | --- |
| **0. Foundation** | H6, L4, L1, M5 | The zod 4 upgrade touches every schema; doing it first means every new schema in later phases is written once. Indexes and versioning are small and unblock the rest. |
| **1. Delivery reliability** | H1, B2, H2, B3 | All change the worker's `deliver` function. H1 must land with B2 (longer retries widen the duplicate window). H2 is needed before B5 introduces `DEGRADED`. B3 adds the `priority` column. |
| **2. Domain lifecycle** | B5 | Needs H2 in place so a failed re-check never fails queued mail. |
| **3. Operations safety** | B4, H5, M10 | Alerts, uptime monitoring, the worker heartbeat and backups must work before anything is exposed to customers. |
| **4. Security hardening** | H3, M6, M7, M8, L2 | Independent of each other; can be split between engineers. |
| **5. Sending behaviour and compliance** | M4, H7, B1, B6 | M4 and H7 change acceptance and tracking defaults; B1 fires the tracking webhooks after bot filtering exists; B6 builds on the same tracking-domain routes and signer. |
| **6. SMTP relay correctness** | M1, M2, M3 | Uses the per-recipient suppression from M4. |
| **7. Abuse controls** | H4, L3 | Needed before outside customers can sign up. |
| **8. Developer experience** | M9, B7 | Test mode must exist before the SDKs are published, so the published docs and SDKs include it, along with B1 and B6 changes. |
| **9. Feature parity** | F3, F4, F1, F2, F5 | F3 is small; F4 must come before F2; F5 (second IP, failover) completes the infrastructure. |
| **10. Release gate** | section 5 | Final verification on staging, then production. |

Notes on running phases in parallel:
- Phase 4 can run alongside phases 1 to 3 (different files).
- Phase 9's F1 (inbound) can start once phase 3 is done.
- Do not start phase 5 before phase 1 is merged: both touch the worker and `email-service.ts`.

Every item gets its own pull request referencing its ID (for example `fix(B2): …`), with the
acceptance check implemented as an automated test wherever possible. When an item is merged,
tick it in section 6.

---

## 5. Release gate

All of the following must hold on staging, then be repeated on production before announcing:

1. Every item in section 6 is ticked.
2. CI is green, including the new `npm audit --audit-level=high` step; lint has no warnings.
3. `npm run test:smoke`, `test:accounts`, `test:delivery` and `test:developer` pass against
   staging.
4. Real delivery to Gmail, Outlook.com, Yahoo and iCloud from a customer test domain: each
   message lands in the inbox, and the headers show `dkim=pass`, `spf=pass`, `dmarc=pass`.
   Gmail shows the unsubscribe link for a message sent with `unsubscribe: true`.
5. Failure drills, each with the expected outcome observed:
   - stop KumoMTA for 10 minutes: no email fails, all are delivered afterwards, an alert
     reaches the out-of-band channel;
   - stop the worker: `/health/ready` reports it within 5 minutes and the uptime monitor
     alerts;
   - flush Redis: the outbox sweeper re-queues everything within 2 minutes;
   - restore the database from an off-server backup onto a fresh stack.
6. Webhooks: an endpoint subscribed to `*` receives every event type once, with valid
   signatures.
7. Billing: an STK payment and a Paybill payment in the Daraja sandbox are applied; a Paybill
   callback from a non-allowlisted IP is refused.
8. The production runbook's go-live checklist is complete, including PTR, warm-up start date,
   `MPESA_ALLOWED_IPS`, backups with an off-server remote, and the uptime monitor.

---

## 6. Tracking checklist

**Phase 0:**
- [x] H6 dependencies
- [x] L4 lint
- [x] L1 versions
- [x] M5 indexes

**Phase 1:**
- [x] H1 duplicate sends
- [x] B2 retry window
- [x] H2 domain status in worker
- [x] B3 system mail priority

**Phase 2:**
- [x] B5 automatic domain checks

**Phase 3:**
- [x] B4 out-of-band alerts and heartbeat
- [x] H5 automated backups
- [x] M10 seed role reset

**Phase 4:**
- [x] H3 M-Pesa allowlist
- [x] M6 rate limiting
- [x] M7 SSRF pinning
- [x] M8 webhook secret encryption
- [x] L2 CSP

**Phase 5:**
- [x] M4 per-recipient suppression
- [x] H7 tracking defaults and bots
- [x] B1 open/click webhooks
- [x] B6 one-click unsubscribe

**Phase 6:**
- [x] M1 relay validation
- [x] M2 split messages
- [x] M3 Message-ID claims

**Phase 7:**
- [ ] H4 sending approval
- [ ] L3 workspace limit

**Phase 8:**
- [x] M9 test mode
- [ ] B7 published SDKs (the package is no longer private and the docs install from the repository; the npm publish is still to do)

**Phase 9:**
- [ ] F3 domain-scoped keys
- [ ] F4 streams
- [ ] F1 inbound
- [ ] F2 broadcasts
- [ ] F5 second IP and failover

**Phase 10:**
- [ ] Release gate passed on staging
- [ ] Release gate passed on production


---

## 7. Implementation log

What was built for each closed item, and where it differs from the plan above. Branch:
`remediation/pre-deployment`.

### Phase 0 (29 October 2026)

- **H6.** `zod` 4 in `@tredmail/api` and `@tredmail/core` (`.errors` → `.issues`, two-argument
  `z.record`, `.prefault("month")` where a default must still be parsed). `smtp-server`
  3.21.3, `mailparser` 3.14.1, `nodemailer` 10.3.1. `npm audit --omit=dev`: 0 vulnerabilities.
  CI fails on high-severity advisories (backend and console jobs).
- **L4.** No warnings left; `npm run lint` uses `--max-warnings=0`.
- **L1.** One platform version (1.4.0) in `packages/core/src/config/version.ts`, used by
  `/health` and the OpenAPI spec. `tests/version.test.ts` fails if any released package
  disagrees. The SDKs keep their own versions.
- **M5.** Migration `20261029000000_remediation_indexes`. Delivery-event de-duplication now
  uses an `email_events.dedupeKey` column with a unique `(emailId, dedupeKey)` index; the
  insert itself rejects a duplicate, which also closes a race between concurrent KumoMTA
  retries. Existing keys are backfilled from `details`.

### Phase 1 (29 October 2026)

Rules live in `packages/core/src/delivery/attempts.ts` (unit-tested); the worker applies them.
Migration `20261029010000_delivery_reliability`.

- **B2.** 30 attempts: 30 s, 1, 2, 5, 10 minutes, then every 15 minutes (about 6 h 20 min).
  A 5xx refusal of the message is permanent; 4xx replies, login failures and any failure
  before `DATA` are retried. Errors are now readable on the timeline: connection failures
  arrive as an `AggregateError` with an empty message and were previously recorded blank.
- **H1.** Differs from the plan: instead of an `X-TredMail-Attempt` header, the worker stamps
  `sendAttemptAt`/`sendRoute` before each hand-off, and KumoMTA reports its `Reception` log
  record for worker-injected (VERP) mail, which sets `emails.mtaAcceptedAt`. A retry that finds
  an interrupted attempt records SENT without resending if KumoMTA has the message, waits up to
  2 minutes for the report otherwise, then resends. A definite failure clears the marker so
  ordinary retries are not delayed. The SENT write is retried in-process. Mail through the
  fallback relay cannot be checked this way and stays at-least-once.
- **H2.** Mail from a domain that is not `VERIFIED` or `DEGRADED` is held (re-checked every
  30 minutes, one `DEFERRED: domain_not_verified` event) and fails only 72 hours after it was
  due.
- **B3.** Differs from the plan: instead of BullMQ job priorities, SYSTEM mail has its own queue
  (`tredmail-system-delivery`) and worker, so it can never wait behind customer mail.
  `emails.priority` records it; system mail skips the warm-up cap and plan usage.

Verified end to end on a development machine (API, worker, KumoMTA, Mailpit): delivery with
the reception report recorded; customer mail held at an exhausted warm-up cap while a
password-reset email was delivered; KumoMTA stopped, emails retried and were each delivered
exactly once after it restarted; an email whose domain became unverified was held, not
failed.

### Phase 2 (29 October 2026)

- **B5.** `packages/core/src/dns/domain-check.ts` (transitions unit-tested in
  `tests/domains.test.ts`), run every minute by the worker's `domain-checks` job and by
  `POST /v1/domains/:id/verify`. Migration `20261029020000_domain_checks` adds
  `nextCheckAt`, `failingSince` and `lastCheckError` and schedules every existing domain.
  Additions to the plan:
  - a check DNS could not answer (timeout, server failure) changes nothing and is retried in
    15 minutes, so a resolver problem never degrades a domain;
  - `FAILED` domains keep being checked daily and recover by themselves;
  - notices go to the workspace's Owners and Admins; the `domain.updated` webhook event is
    new (OpenAPI, console webhook form);
  - `DOMAIN_AUTO_CHECKS` (default on, off in development, where seeded domains have no real
    DNS records);
  - the console shows degraded and failed states with what the check found, and the next
    check time.

  Verified against real DNS: a seeded domain without TredMail's records went from `VERIFIED`
  to `DEGRADED`, with an audit entry and notices queued to its Owner and Admin.

### Phase 3 (29 October 2026)

- **B4.** `packages/core/src/services/ops-alerts.ts` sends every operations alert (delivery
  health, blocklists, paused workspaces, unmatched payments) to `ALERT_WEBHOOK_URL` (new; Slack,
  Mattermost, Discord or Google Chat) and to `OPS_EMAIL`, emailed through `FALLBACK_SMTP_*`
  when set so it does not depend on KumoMTA. The worker writes a heartbeat to Redis every
  minute; `GET /health/worker` returns 503 when it is over 5 minutes old. It is a separate
  endpoint, not part of `/health/ready`, because the worker container waits for the API to be
  healthy and tying the two together would deadlock a fresh deploy. The worker warns at start
  when no independent alert channel is configured. Runbook 6.6 describes the uptime monitor.
- **H5.** `scripts/backup.sh` (nightly cron installed by the deploy script): dump, readability
  check, age encryption of the dump and of `.env` to a public key (the server cannot decrypt
  its own backups), rclone upload of the encrypted copies only, 14-day local retention, and a
  chat alert on failure. `scripts/restore.sh` restores into a scratch database for drills or,
  with `--yes`, replaces the live one. The new `check-keys` CLI proves the restored DKIM keys
  decrypt with the master key. Runbook 6.3 rewritten; go-live checklist updated.
- **M10.** The seed creates the admin's membership once and no longer resets its role.

Also fixed: since Phase 2 the seed CLI imported the domain-check service, whose mail and queue
imports open a Redis connection, so `seed.js` never exited and would have hung the deploy
script. The pure scheduling rules now live in `dns/domain-schedule.ts`. Every CLI the deploy
and runbook use (seed, check-keys, staff, revoke-api-key, payments-setup) was checked to exit
on its own.

Verified on a development machine: with KumoMTA stopped, a test alert reached a chat webhook
and the ops mailbox (via the fallback path); `/health/worker` answered 503 before the worker
started and 200 after; a backup of the development database was written and checked, restored
into a scratch database (12 workspaces, 5 domains, 141 emails) and `check-keys` passed with the
right master key and failed with a wrong one; the seed kept a changed role. Not yet exercised:
the age encryption and rclone upload steps (no binaries on the development machine); they are
part of the staging restore drill in the release gate.

### Phase 4 (29 October 2026)

- **H3.** With live M-Pesa (`MPESA_ENVIRONMENT=production`) the configuration is refused
  without `MPESA_ALLOWED_IPS` (staging on the Daraja sandbox is not affected). The callback
  token is redacted from the API's request logs (`security/log-redaction.ts`; production logs
  at `info`, so it was being written). Paybill payments of at least
  `BILLING_LARGE_PAYMENT_ALERT` (default KES 50,000) raise an operations alert. Safaricom's
  current callback addresses must be confirmed with Safaricom before go-live; the repository
  does not hard-code them.
- **M6.** `security/ip-limits.ts`: after 30 invalid API keys from one address in a minute the
  API answers 429 (with `Retry-After`) without a database lookup; malformed keys are refused
  without a lookup at all. A ceiling of `RATE_LIMIT_PER_IP_PER_MINUTE` (default 3,000) applies
  per address on top of the per-key limit. Both use a sliding one-minute window (the first
  live test showed fixed windows letting a burst through across a minute boundary) and fail
  open if Redis is unreachable. Trade-off: an application on the same address as others that
  keeps using a wrong key blocks that address for up to a minute.
- **M7.** Webhook deliveries use `fetchPublicUrl` (undici `Agent` with a connect-time lookup
  that refuses private and reserved addresses), so the address checked is the one connected
  to. Development with `WEBHOOK_ALLOW_PRIVATE_TARGETS` keeps plain fetch.
- **M8.** Webhook signing secrets are stored encrypted with the master key. Old plain rows keep
  working; the new `encrypt-secrets` CLI converts them and runs on every deploy (and in the
  runbook's upgrade steps). `check-keys` now also checks webhook secrets.
- **L2.** Content-Security-Policy on every console page in production builds. Images and fonts
  may be remote because the sandboxed email previews inherit the policy; scripts, styles and
  API calls are same-origin (`'unsafe-inline'` for Next.js's inline scripts).

Verified on a development machine: 30 invalid keys answered 401, the next 429 with
`Retry-After`; a real HTTPS request through the pinned client succeeded while `localhost` and
`169.254.169.254` were refused; a legacy plain webhook secret was encrypted by `encrypt-secrets`
(a second run changed nothing) and `check-keys` decrypted it; the console production build
served the policy on the sign-in, docs, API reference and overview pages with no external
scripts or stylesheets. Still to check on staging in a browser: no CSP violations in the
console (console open with the developer tools), including Google sign-in and the previews.

### Phase 5 (29 October 2026)

Migration `20261029030000_sending_compliance`.

- **M4.** `acceptEmail` drops suppressed recipients and lists them in the response
  (`suppressed`, also in the OpenAPI spec and Node SDK); `recipient_suppressed` only when every
  recipient is suppressed. The worker re-checks suppressions just before sending, drops anyone
  suppressed since acceptance (recorded on the SENT event) and fails the email, releasing its
  plan usage, only if nobody is left.
- **H7.** New workspaces have open and click tracking off (`trackOpensDefault` /
  `trackClicksDefault`, set in console Settings and `PATCH /v1/workspace`); workspaces that
  existed before the migration keep it on, as before. Click tracking never rewrites
  account-security links (reset, verify, magic sign-in, invitations, unsubscribe...) or links
  marked `data-tredmail-notrack`. `mail/engagement.ts` flags opens and clicks by scanners,
  previewers, Apple's privacy prefetch and clicks within 10 seconds of the hand-off
  (`email_events.bot`); they stay on the timeline (labelled "automated" in the console) and are
  left out of stats and webhooks. Gmail's and Yahoo's image proxies count as people.
- **B1.** `email.opened` and `email.clicked` (with `link_url`) are sent for people; repeat
  opens from the same address within a minute send one webhook.
- **B6.** Senders may set their own `List-Unsubscribe` / `List-Unsubscribe-Post` (format
  checked). `unsubscribe: true` (SMTP: `X-TredMail-Unsubscribe: true`) adds TredMail's signed
  one-click headers; it needs exactly one recipient, since the header is the same for every
  recipient. `GET /v1/track/unsubscribe/:id` only shows a confirmation page (scanners follow
  links); the POST, from the mail client or the page's button, suppresses the recipient
  (`UNSUBSCRIBE`, an existing bounce or complaint suppression is kept), records an
  `UNSUBSCRIBED` event once and sends the new `email.unsubscribed` webhook. Docs: sending and
  webhooks pages.
- Also: an invalid `scheduled_at` (possible through the SMTP relay header) is now a 422 instead
  of a database error and endless retries (part of M1, phase 6).

Verified end to end on a development machine (API, worker, KumoMTA, Mailpit, a local webhook
receiver): a send to one suppressed and one valid recipient went to the valid one and listed
the other; an all-suppressed send got 422; a newsletter carried both unsubscribe headers and
left its password-reset link untouched; a scanner click and an Apple prefetch open were flagged
and sent no webhook, while a person's click and open each sent one; GET on the unsubscribe URL
changed nothing, POST suppressed the reader once (a second POST sent no second webhook) and the
next email to them was refused; a recipient suppressed after a scheduled email was accepted was
dropped at send time while the other recipient received it.

### Phase 6 (9 November 2026)

- **M1.** The SMTP relay checks every request with the API's `sendEmailSchema`. A failure is a
  permanent `554 5.6.0` carrying the first issue, so a client does not retry it forever.
- **M2.** A split message (Bcc only, one email per recipient) is checked part by part before any
  part is accepted (`prepareSend`). The plan's quota is reserved once for the accepted parts, and
  the parts are then saved and queued (`commitSend`). When at least one part is accepted, the
  parts that were refused are recorded as `FAILED` emails, which show in the console and fire
  `email.failed`, and the client gets `250`. A refused part is recorded only when its sender
  domain is registered in the workspace; otherwise the refusal is logged.
- **M3.** A Message-ID claim that is finished is answered as a duplicate. One that is unfinished
  and younger than 5 minutes gets `451` (the first attempt is still running). An older unfinished
  claim is taken over, because that attempt has died.

Verified end to end with real SMTP clients against Postgres and Redis (12 checks): a split
message with one suppressed recipient was accepted with two parts queued and one recorded as
failed; an invalid schedule header was refused permanently; a retry during the first attempt got
`451`; a stale claim was taken over; a finished claim was answered as a duplicate.

### Phase 8 (9 November 2026)

- **M9.** A `tred_test_` key validates and records each email, but nothing is delivered. The
  email is stored as `DELIVERED` with `isTest` set and a `TEST_MODE` event, it does not count
  against the plan, it is left out of the statistics, and webhooks carry `test: true` (a test
  email fires `email.delivered`). Keys are created live or test with `mode` on
  `POST /v1/api-keys`, and the console's create-key form has a Live/Test choice. Documented on
  the sending page. The schema change is migration `20261110000000_test_mode`.

Verified through the API (live and test keys, usage and statistics) and through the SMTP relay
(5 and 4 checks respectively).

### Pre-launch audit fixes (9 November 2026)

Fixes for the audit in `docs/production-gaps.md`, outside the remediation list above:

- **Launch blockers 1–4:** blank configuration values (`OPS_EMAIL`, `BILLING_SUPPORT_EMAIL`,
  `MTA_WARMUP_START`) no longer fail validation; the worker accepts KumoMTA's internal port
  without STARTTLS when `SMTP_SKIP_STARTTLS` is set (production, `kumomta` host only); the
  onboarding page refreshes the cached workspace list before opening the console.
- **Blockers 5–8:** DEGRADED domains can send from the API; the API and relay use a Redis
  connection that fails at once during an outage (`request-redis.ts`), and enqueueing is capped at
  2 seconds; the maintenance schedules are re-created within a minute after a Redis loss; the
  outbox sweeper re-queues stale SENDING rows (the reception check prevents a duplicate send).
- **Smaller issues:** the worker never overwrites a delivery report with `SENT`; the smoke test
  turns tracking on explicitly; `.gitignore` covers `certs/`, `*.pem`, `*.key` and `.env.*`; the
  README no longer claims marketing email; the Node SDK is no longer marked private and the docs
  show repository-relative install paths.
- **Blank values:** `loadEnv` treats any blank variable as unset, so a copied `.env.example` loads.

The unit suite passes (138 tests), and typecheck and lint are clean.
