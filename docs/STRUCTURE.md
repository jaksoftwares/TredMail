# TredMail structure

TredMail is a self-hosted transactional email platform: an HTTP API, an SMTP relay, a delivery
worker, a web console, and the delivery engine (KumoMTA). It is a single npm workspace monorepo
with TypeScript throughout. For the architecture and the reasoning behind it, see
`ARCHITECTURE.md`; for running it, see `RUNNING.md`.

## Top level

| Path | What it holds |
| --- | --- |
| `apps/` | The four deployable programs: `api`, `worker`, `smtp-relay`, `console`. |
| `packages/` | Shared code: `core` (the business logic), `db` (the database schema), `sdk-node` and `sdk-python` (client libraries for customers). |
| `mta/policy/` | The KumoMTA policy (`init.lua`): how mail is injected, signed and delivered, and how reports are posted back. |
| `scripts/` | End-to-end checks (`smoke-test`, `accounts-test`, `delivery-test`, `developer-test`), backup and restore, certificate sync, and the payment simulator. |
| `docs/` | Architecture, runbooks, the remediation plan and the implementation log. |
| `docker-compose.yml` | Local development services: PostgreSQL, Redis, Mailpit, KumoMTA (profile `mta`). |
| `docker-compose.prod.yml`, `Caddyfile`, `Dockerfile`, `deploy-hostinger.sh` | Production: the full stack behind Caddy, the image, and the deployment script for a Hostinger VPS. |
| `.github/workflows/ci.yml` | CI: secret scan, dependency audit, typecheck, lint, unit tests, migrations, console build, Python SDK tests. |
| `branding/` | Logos and brand files used by the console and emails. |
| `examples/` | Small sample integrations. |

## The four apps

**`apps/api`** is the HTTP API (Fastify). `src/app.ts` builds the server and registers the
routes; `src/server.ts` starts it. Routes live in `src/routes/`, grouped by resource:

- `emails`, `templates`, `domains`, `suppressions`, `webhooks`, `api-keys`, `stats`, `usage`: the
  public sending API under `/v1`.
- `account`, `billing`, `admin`: the console's own endpoints (workspace, members, invitations,
  billing, and the staff back-office under `/v1/admin`).
- `tracking`: the open and click endpoints in emails, and the one-click unsubscribe.
- `mta`, `bounces`: internal endpoints under `/internal`, where KumoMTA posts delivery reports and
  inbound mail. They are not exposed publicly.
- `payment-callbacks`: M-Pesa callbacks.
- `openapi`: the generated API document.

`src/middleware/` holds authentication (API keys and console sessions), scope and role checks.
`src/cli/` holds the operations commands (seed, staff, key revocation, secret encryption).

**`apps/worker`** delivers mail and runs the background work. `src/index.ts` pulls email jobs off
the queue, signs and sends each message through KumoMTA (or the fallback relay, or staging), and
records the result. `src/monitor.ts` runs the maintenance schedules: health checks, the outbox
sweeper, retention, billing, payment reconciliation, domain checks and the circuit breaker.
`src/webhooks.ts` delivers outgoing webhooks with retries.

**`apps/smtp-relay`** lets existing software send through TredMail with SMTP. It authenticates
with an API key as the password, converts each message (`src/convert.ts`) into the same send
request the API takes, and accepts it with the same rules. Ports 587 (STARTTLS) and 465 (TLS) in
production.

**`apps/console`** is the web interface (Next.js). Route groups:

- `(app)`: the signed-in workspace: overview, emails, domains, templates, webhooks, API keys,
  suppressions, billing, settings, and `admin` for staff.
- `(auth)`: sign-up, sign-in, verification, password reset, invitations, two-factor.
- `(docs)`: the public API and SDK documentation.
- `(legal)`: the Terms of Service and Privacy Policy.

## The shared core

`packages/core/src` is where the rules live. The apps are thin wrappers around it, so a rule
written once applies to the API, the relay and the console.

| Folder | Purpose |
| --- | --- |
| `services/email-service.ts` | Accepting a send: `prepareSend` runs every check with no side effects, `commitSend` records and queues it, `acceptEmail` joins them with usage reservation. Also cancellation and rescheduling. |
| `services/delivery-events.ts` | Turns delivery reports (delivered, deferred, bounced, complained, opened, clicked) into email status changes, suppressions and webhooks. |
| `services/circuit-breaker.ts` | Pauses a workspace's sending when its bounce or complaint rate is too high. |
| `services/sending-approval.ts` | The sending approval and the workspace limit for new accounts. |
| `services/ops-alerts.ts`, `audit.ts`, `system-mailer.ts`, `inbound-mail.ts`, `heartbeat.ts` | Operations alerts, the audit log, TredMail's own mail, inbound mail, and the worker heartbeat. |
| `delivery/` | Retry timing and send-error classification (`attempts.ts`), IP warm-up limits (`warmup.ts`), and the staging allowlist. |
| `queue/` | BullMQ queues on Redis. `redis.ts` is the worker's connection; `request-redis.ts` is the request handlers' connection, which fails fast during an outage. |
| `billing/` | Plans and entitlements, usage counting, invoices, subscriptions, the billing cycle, and the M-Pesa gateway (`gateways/`). |
| `dns/` | Domain verification (SPF, DKIM, DMARC, return path) and the schedule for re-checking domains. |
| `mail/` | MIME building, the VERP return path that maps bounces to emails, templates, the bounce classifier, DMARC report parsing, and open and click engagement. |
| `security/` | API key generation and hashing, encryption of stored secrets, DKIM keys, scopes and roles, per-IP limits, log redaction, tracking-link signatures, and URL safety for webhooks. |
| `webhooks/` | The list of event types and the signed dispatcher. |
| `config/env.ts` | Every configuration variable, validated at start-up. |
| `openapi/` | The API specification. |

`packages/db/prisma/` holds the Prisma schema and the migrations, one folder per change, applied in
order by `npm run db:deploy`.

## Following one email

1. A client calls `POST /v1/emails` (or submits to the SMTP relay). The API authenticates the key
   and checks its scope and the per-key and per-IP limits.
2. `acceptEmail` runs the checks: content, sender domain, suppressions, workspace standing,
   sending approval and the plan's quota. Nothing is written until every check passes.
3. The email row and its first event are written to PostgreSQL, and a job is queued in Redis. If
   Redis is down, the outbox sweeper queues the job within a minute, so nothing is lost.
4. The worker takes the job, re-checks the domain and suppressions, signs the message with DKIM,
   and sends it to KumoMTA with a VERP return path.
5. KumoMTA delivers the message and posts each result (delivered, bounced, complained) to
   `/internal/mta`. The API records the event, updates the email, and fires the customer's
   webhooks.
6. Opens and clicks are recorded when a recipient's client loads the tracking pixel or follows a
   link. Automated opens and clicks are flagged and left out of statistics.

## Where to look for common changes

| To change | Look in |
| --- | --- |
| An API endpoint | `apps/api/src/routes/`, then its schema in `packages/core/src/services/email-validation.ts` or the route file |
| A send rule (for example a new refusal reason) | `packages/core/src/services/email-service.ts` |
| How delivery retries or classifies errors | `packages/core/src/delivery/attempts.ts` and `apps/worker/src/index.ts` |
| A background job | `apps/worker/src/monitor.ts` |
| A database table or column | `packages/db/prisma/schema.prisma`, then `npm run db:migrate` |
| A console page | `apps/console/src/app/(app)/` |
| A plan or price | `packages/core/src/billing/plans.ts` and the admin plan routes |
| A configuration variable | `packages/core/src/config/env.ts` and `.env.example` |
| The API document | regenerate with `npm run openapi:export` |

## Tests

Unit tests sit beside the code they test: `packages/core/tests/` and `apps/api/tests/`, run from the
root with `npm test` (Vitest). The end-to-end scripts in `scripts/` exercise a running stack. The
two kinds of check are complementary: the unit tests cover rules, and the scripts cover the path
from HTTP through the queue and the delivery engine.
