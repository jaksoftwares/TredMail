# TredMail production runbook

How to take TredMail to production and run it day to day. This is for whoever deploys and
operates TredMail at Dovepeak Technologies. Read section 1 for the system's layout, follow
section 4 once to go live, and keep sections 6 to 8 for daily operations.

Background detail lives in other documents:
- `docs/PRODUCTION_INFRASTRUCTURE.md`: reverse DNS, warm-up and mailbox programs.
- `docs/BILLING_AND_PAYMENTS.md`: plans, M-Pesa and the back-office.

---

## 1. What TredMail is and how it is built

TredMail is Dovepeak's transactional email service, replacing Resend, Postmark and SendGrid:
- applications send email through an HTTP API or SMTP;
- TredMail signs each message with DKIM and delivers it from its own mail server (KumoMTA);
- it tracks delivery, bounces, opens and clicks, and notifies applications by webhook;
- it bills outside customers through M-Pesa.

### Request flow

```
                        Internet
                           │
          ┌────────────────┼─────────────────────────────┬──────────────┐
          │ HTTPS 443      │ SMTP 587/465                │ SMTP 25 in   │ SMTP 25 out
          ▼                ▼                             ▼              ▲
     ┌─────────┐     ┌────────────┐                ┌──────────┐         │
     │  Caddy  │     │ smtp-relay │                │ KumoMTA  │─────────┘ delivers to Gmail,
     │ (TLS)   │     └─────┬──────┘                │ (mta)    │           Outlook, Yahoo ...
     └────┬────┘           │ uses the same          └────┬─────┘
          │                │ email service               │ bounces, delivery results,
   ┌──────┴───────┐        │                             │ inbound mail → API (internal)
   ▼              ▼        ▼                             │
┌─────────┐   ┌────────────────┐   jobs   ┌──────────┐   │
│ console │   │      api       │ ───────► │  worker  │ ──┘ hands signed mail to KumoMTA
│ Next.js │   │   (Fastify)    │  Redis   │ (BullMQ) │     (port 2525, internal)
└─────────┘   └───────┬────────┘          └────┬─────┘
                      │        PostgreSQL      │
                      └──────────┬─────────────┘
                                 ▼
                          ┌────────────┐
                          │  postgres  │  the source of truth (emails, billing, ...)
                          └────────────┘
```

**Key design points:**
- **Postgres is the source of truth.** Redis queue jobs carry only ids, and the worker
  re-queues anything Redis lost within a minute. Losing Redis loses no mail; losing Postgres
  loses everything, so back it up (section 6.3).
- **All sends go through one service** (`packages/core/src/services/email-service.ts`): API,
  batch, SMTP relay and TredMail's own account emails. Limits, suppressions and billing usage
  apply to every path the same way.
- **The worker also runs the clocks:** health checks and alerts (every 15 minutes), the
  outbox sweep (every minute), data retention (daily at 02:30 UTC), the billing cycle
  (every 10 minutes) and M-Pesa reconciliation (every minute).

### Containers (`docker-compose.prod.yml`)

| Service | What it does | Ports |
| --- | --- | --- |
| `caddy` | HTTPS for every hostname (Let's Encrypt certificates), routing, MTA-STS policy | 80, 443 public |
| `console` | Web console (Next.js): customer UI, docs at `/docs`, back-office at `/admin` | internal 3000 |
| `api` | REST API `/v1`, console authentication, tracking, payment callbacks, internal MTA callbacks | internal 3000 |
| `worker` | Sends queued email, delivers webhooks, runs scheduled jobs | none |
| `kumomta` | Mail server: outbound delivery, inbound bounces and reports | 25 public, 2525 internal |
| `smtp-relay` | SMTP submission for applications (password = API key) | 587, 465 public |
| `postgres` | PostgreSQL 16 | internal |
| `redis` | Queues, rate limits, alert cooldowns | internal |
| `mailpit`, `kumomta-staging` | Staging only | — |

The `mta` profile (KumoMTA and the relay) runs in production only.

### Repository layout

```
apps/
  api/            Fastify API. src/routes/* = endpoints, src/cli/* = admin commands
                  (seed, staff, payments-setup, revoke-api-key)
  worker/         BullMQ worker: index.ts (sending), webhooks.ts, monitor.ts (scheduled jobs)
  smtp-relay/     SMTP submission server for applications
  console/        Next.js console (separate npm project): src/app/(app) = signed-in pages,
                  (auth) = sign-in/up, (docs) = public docs, admin/ = staff back-office
packages/
  core/           Shared business logic, used by api, worker and relay:
                    services/   email sending, audit, circuit breaker, system mail
                    billing/    plans, usage, invoices, cycle, payment gateways (gateways/mpesa.ts)
                    mail/       MIME, DKIM templates, bounce parsing, DMARC reports, email templates
                    dns/        DNS record generation and verification
                    security/   encryption, API keys, scopes, roles
                    webhooks/   webhook signing and dispatch
                    openapi/    the public API description
                    config/     env.ts = every setting, validated at startup
  db/             Prisma schema and migrations (packages/db/prisma)
  sdk-node/       Node.js SDK (@dovepeak/tredmail)
  sdk-python/     Python SDK (tredmail)
mta/policy/       KumoMTA configuration (init.lua)
scripts/          cert-sync.sh (certificates to KumoMTA), test scripts, Daraja simulator
Caddyfile         HTTPS routing
deploy-hostinger.sh   One-command server setup and deploy
docs/             Guides and phase reports
```

---

## 2. Production values

| Item | Value |
| --- | --- |
| Server | Hostinger KVM 4 (4 vCPU, 16 GB RAM, 200 GB NVMe), Ubuntu |
| DNS provider | Namecheap, for `dovepeakdigital.com` (Zoho Mail on the root domain is left untouched) |
| Console | `https://console.tredmail.dovepeakdigital.com` |
| API | `https://api.tredmail.dovepeakdigital.com/v1` |
| API reference | `https://api.tredmail.dovepeakdigital.com/v1/openapi.json`, rendered at `https://console.tredmail.dovepeakdigital.com/docs/api` |
| Tracking | `https://track.tredmail.dovepeakdigital.com` |
| SMTP relay for applications | `smtp.tredmail.dovepeakdigital.com`, port 587 (STARTTLS) or 465 (TLS); username anything, password = an API key |
| Mail server (HELO, PTR) | `mta1.tredmail.dovepeakdigital.com` |
| TredMail's own sending domain | `tredmail.dovepeakdigital.com` (account emails from `no-reply@`, sandbox from `onboarding@`) |
| Bounce domain | `bounces.tredmail.dovepeakdigital.com` |
| M-Pesa callbacks | `https://api.tredmail.dovepeakdigital.com/v1/payments/callbacks/mobile/{stk,confirm,validate}/<secret token>`, built automatically (section 4.7) |
| Health checks | `https://api.tredmail.dovepeakdigital.com/health` (process up) and `/health/ready` (database and Redis reachable) |
| Seeded owner login | `admin@dovepeakdigital.com`. The password is printed once by the first deploy. |

---

## 3. Before you start: accounts and information to collect

| What | Where you get it | Used in |
| --- | --- | --- |
| Server IP address | Hostinger hPanel → VPS | DNS records, PTR |
| SSH access to the server (root or a sudo user) | Hostinger hPanel | everything |
| Namecheap login for `dovepeakdigital.com` | Namecheap | DNS (section 4.2) |
| A real mailbox for alerts and postmaster/abuse mail, e.g. `ops@dovepeakdigital.com` (Zoho) | Zoho Mail | `OPS_EMAIL` |
| Daraja **production** app: consumer key and secret | developer.safaricom.co.ke → My Apps (after Go Live approval) | `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET` |
| Lipa na M-Pesa Online passkey | Safaricom (sent with Go Live approval) | `MPESA_PASSKEY` |
| Store (head office) number, and till number | your Buy Goods registration with Safaricom | `MPESA_SHORTCODE` (store), `MPESA_PARTY_B` (till) |
| Dovepeak's KRA PIN (optional) | KRA iTax | `BILLING_TAX_ID` |
| Google OAuth client (optional, for "Sign in with Google") | console.cloud.google.com → Credentials | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

---

## 4. Going live, step by step

Do the steps in order. Expect a day or two of elapsed time, mostly waiting for Hostinger and
for DNS to update.

### 4.1 Ask Hostinger for mail-server permissions (1 to 2 business days)

Send the support request in `docs/PRODUCTION_INFRASTRUCTURE.md` section 2. It asks for:
- outbound port 25 to be unblocked;
- inbound ports 25, 587 and 465;
- reverse DNS (PTR) for the server IP set to `mta1.tredmail.dovepeakdigital.com`. You can
  often set this yourself under hPanel → VPS → Settings → PTR record.

Add the `mta1.tredmail` A record (4.2, record 4) **before** sending the request.

### 4.2 DNS records at Namecheap

In Namecheap → Domain List → `dovepeakdigital.com` → Advanced DNS, add the records below.
Replace `<SERVER_IP>` with the server's IPv4 address. Hosts are written without
`.dovepeakdigital.com`, because Namecheap adds it.

| # | Type | Host | Value | When |
| --- | --- | --- | --- | --- |
| 1 | A | `console.tredmail` | `<SERVER_IP>` | now |
| 2 | A | `api.tredmail` | `<SERVER_IP>` | now |
| 3 | A | `track.tredmail` | `<SERVER_IP>` | now |
| 4 | A | `mta1.tredmail` | `<SERVER_IP>` | now (before the Hostinger request) |
| 5 | MX | `bounces.tredmail` | `mta1.tredmail.dovepeakdigital.com` (priority 10) | now |
| 6 | MX | `tredmail` | `mta1.tredmail.dovepeakdigital.com` (priority 10) | now |
| 7 | TXT | `_spf.tredmail` | `v=spf1 ip4:<SERVER_IP> -all` | now |
| 8 | TXT | `tredmail` | `v=spf1 include:_spf.tredmail.dovepeakdigital.com ~all` | now |
| 9 | TXT | `bounces.tredmail` | `v=spf1 include:_spf.tredmail.dovepeakdigital.com ~all` | now |
| 10 | TXT | `mta1.tredmail` | `v=spf1 a -all` | now |
| 11 | TXT | `_dmarc.tredmail` | `v=DMARC1; p=none; rua=mailto:dmarc@tredmail.dovepeakdigital.com; adkim=r; aspf=r; pct=100` | now |
| 12 | TXT | `_smtp._tls.tredmail` | `v=TLSRPTv1; rua=mailto:tls-reports@tredmail.dovepeakdigital.com` | now |
| 13 | TXT | `tredmail._domainkey.tredmail` | the DKIM value the first deploy prints (4.4) | after the first deploy |
| 14 | A | `smtp.tredmail` | `<SERVER_IP>` | now |
| 15 | A | `mta-sts.tredmail` | `<SERVER_IP>` | now |
| 16 | A | `mta-sts.bounces.tredmail` | `<SERVER_IP>` | now |
| 17 | TXT | `_mta-sts.tredmail` | `v=STSv1; id=20261101` | after 4.6 |
| 18 | TXT | `_mta-sts.bounces.tredmail` | `v=STSv1; id=20261101` | after 4.6 |
| 19 | TXT | `*._report._dmarc.tredmail` | `v=DMARC1` | now |

**Notes:**
- Do not touch the existing Zoho records (MX, SPF and DKIM on the root domain).
- Check propagation from any computer, for example `nslookup api.tredmail.dovepeakdigital.com`.
  All A records must resolve before the first deploy, because Caddy needs them to obtain
  certificates.

### 4.3 Prepare the server

SSH in, then clone the repository to `/opt/tredmail`:

```bash
sudo mkdir -p /opt/tredmail && sudo chown $USER /opt/tredmail
git clone <repository URL> /opt/tredmail
cd /opt/tredmail
git checkout <release branch>      # the branch that holds the release
```

### 4.4 First deploy

```bash
cd /opt/tredmail
export CONSOLE_DOMAIN=console.tredmail.dovepeakdigital.com
export API_DOMAIN=api.tredmail.dovepeakdigital.com
export TRACKING_DOMAIN=track.tredmail.dovepeakdigital.com
export OPS_EMAIL=ops@dovepeakdigital.com          # your real alerts mailbox
bash deploy-hostinger.sh
```

**What the script does:**
1. Installs Docker and checks the PTR record and outbound port 25 (it prints warnings, it does
   not stop).
2. Opens the firewall ports.
3. **Creates `.env`** with freshly generated secrets: the encryption key, internal token,
   session secret and database password.
4. Builds the images, runs the database migrations and starts everything.
5. Installs the certificate-sync cron job.
6. Runs the seed.

**Write down two things from the output; they are shown only once:**
- **The owner password** for `admin@dovepeakdigital.com`.
- **The Dovepeak API key** (`tred_live_...`). Store it in your password manager.

The seed also prints DNS records for two domains:
- **`tredmail.dovepeakdigital.com`:** add its DKIM line as **record 13** in 4.2.
- **`dovepeakdigital.com`:** only needed if Dovepeak's apps will send as
  `@dovepeakdigital.com`. Follow "Optional: Dovepeak's own applications sending as
  `@dovepeakdigital.com`" in `docs/PRODUCTION_INFRASTRUCTURE.md`, which **merges** the SPF
  record with Zoho's instead of replacing it.

> **Back up `.env` now**, to a password manager or an encrypted store, not git. If
> `TREDMAIL_MASTER_ENCRYPTION_KEY` is lost, every stored DKIM key and secret is unrecoverable
> and every customer domain must be set up again.

### 4.5 Complete the `.env`

Open `/opt/tredmail/.env`. Add or update these values. The generated lines already hold
secrets; keep them.

```bash
# --- Alerts ---
OPS_EMAIL=ops@dovepeakdigital.com

# --- M-Pesa (Buy Goods / Till) ---
MPESA_ENV=production
MPESA_CONSUMER_KEY=<from Daraja>
MPESA_CONSUMER_SECRET=<from Daraja>
MPESA_SHORTCODE=<store / head office number: the one the passkey belongs to>
MPESA_PASSKEY=<Lipa na M-Pesa Online passkey>
MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline
MPESA_PARTY_B=<till number>
MPESA_CALLBACK_URL=                # leave empty: TredMail uses https://api.tredmail.dovepeakdigital.com
MPESA_VERIFY_CALLBACKS=true

# --- Billing ---
BILLING_SUPPORT_EMAIL=billing@dovepeakdigital.com   # or ops@
BILLING_TAX_RATE=0                 # 16 once Dovepeak is VAT-registered
BILLING_TAX_ID=                    # Dovepeak KRA PIN, printed on invoices

# --- Optional: Google sign-in ---
# Authorised redirect URI in Google Cloud: https://console.tredmail.dovepeakdigital.com/api/auth/callback/google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Apply the changes, then register M-Pesa:

```bash
cd /opt/tredmail
DC="docker compose -f docker-compose.prod.yml --env-file .env -p tredmail-production --profile mta"
$DC up -d                                    # restarts the services whose settings changed
$DC run --rm --no-deps api node apps/api/dist/cli/payments-setup.js
```

`payments-setup` registers the confirmation and validation URLs for your short code. Safaricom
keeps the **first** registration, so run it only once your values are final. Running
`bash deploy-hostinger.sh` again later does the same thing automatically.

### 4.6 Verify the deployment

Run these on the server.

```bash
curl -s https://api.tredmail.dovepeakdigital.com/health/ready     # {"status":"ready","database":"ok","redis":"ok"}
$DC ps                                                             # every service "running" / "healthy"
dig -x <SERVER_IP> +short                                          # mta1.tredmail.dovepeakdigital.com.
openssl s_client -connect mta1.tredmail.dovepeakdigital.com:25 -starttls smtp </dev/null 2>/dev/null | grep subject
                                                                   # CN = mta1.tredmail.dovepeakdigital.com
openssl s_client -connect smtp.tredmail.dovepeakdigital.com:465 </dev/null 2>/dev/null | grep subject
curl -s https://mta-sts.tredmail.dovepeakdigital.com/.well-known/mta-sts.txt   # mode: testing
```

When the `mta1` certificate shows the right name, add **records 17 and 18** (4.2).

### 4.7 First sign-in and security

1. Open `https://console.tredmail.dovepeakdigital.com` and sign in as
   `admin@dovepeakdigital.com` with the printed password.
2. **Change the password:** Settings → Security.
3. **Turn on two-factor authentication** (same page). The back-office (`/admin`) stays closed
   in production until you do.
4. Domains → `dovepeakdigital.com` and the platform domain → press **Verify**. They should
   turn green once DNS has propagated.
5. Send a test email (Overview → "Send test email") to your inbox, and check that it arrives
   with DKIM and SPF passing ("Show original" in Gmail).
6. Add other staff: they sign up first, then run
   `$DC run --rm --no-deps api node apps/api/dist/cli/staff.js grant name@dovepeakdigital.com`.
   List staff with `... staff.js list`.

**The exact M-Pesa callback URLs** (only if Safaricom asks for them; treat them as secrets):

```bash
$DC exec api node -e "const c=require('crypto');const t=c.createHmac('sha256',process.env.TREDMAIL_MASTER_ENCRYPTION_KEY).update('payments-callback:mpesa').digest('hex').slice(0,40);for(const k of ['stk','confirm','validate'])console.log('https://api.tredmail.dovepeakdigital.com/v1/payments/callbacks/mobile/'+k+'/'+t)"
```

### 4.8 First live M-Pesa payment

1. Create a test workspace (workspace switcher → New workspace) and open **Billing**.
2. Enter your phone number in "Payment and billing details" and save.
3. Choose **Pro**, then **Continue to payment**, enter your M-Pesa PIN on the phone, and wait
   for **Payment received**.
4. Check:
   - **Back-office → Gateway log:** an `mpesa/stk` entry with outcome `succeeded`;
   - **Back-office → Payments:** the payment with an M-Pesa receipt number;
   - a receipt email arrived, and the workspace is on Pro.
5. Refund the money in the M-Pesa organisation portal, then press **Record refund** on the
   payment (Back-office → the workspace).

**If the prompt never arrives:** check `$DC logs api | grep -i mpesa`. The usual causes:
- the short code and passkey don't belong together;
- the till is in `MPESA_SHORTCODE` instead of `MPESA_PARTY_B`;
- the app is not approved for production.

### 4.9 Move Dovepeak's applications onto TredMail

Follow the guide at `https://console.tredmail.dovepeakdigital.com/docs/migrate`. For each
application:
1. Add and verify its sending domain (Domains). The console shows the exact records to add at
   Namecheap.
2. Create its own API key (API keys). Give it the `emails:send` scope only, unless it needs
   more.
3. Swap the provider SDK for the TredMail API, SDK or SMTP relay. Move templates and
   webhooks.
4. Import the old provider's suppression list (Suppressions).

After a week of clean sending, cancel Resend, Postmark and SendGrid.

### 4.10 Two weeks after go-live

1. Read the TLS reports sent to `OPS_EMAIL`. If they are clean, set `MTA_STS_MODE=enforce` in
   `.env`.
2. Run `$DC up -d caddy`.
3. Change `id=` in records 17 and 18 to a new value, for example today's date `20261115`.
4. Once warm-up is over (day 20), clear `MTA_WARMUP_START=` in `.env` and run
   `$DC up -d worker`.
5. Consider tightening DMARC (record 11) to `p=quarantine` once the DMARC reports on the
   domain page show only your own IP passing.

---

## 5. Environment variables (production)

Every setting is validated at startup by `packages/core/src/config/env.ts`. A bad value stops
the service with a clear message in `$DC logs api`.

| Variable | Set by | Notes |
| --- | --- | --- |
| `CONSOLE_DOMAIN`, `API_DOMAIN`, `TRACKING_DOMAIN` | deploy script | hostnames from section 2 |
| `TREDMAIL_MASTER_ENCRYPTION_KEY` | deploy script | **never change or lose it**; it encrypts DKIM keys |
| `BETTER_AUTH_SECRET` | deploy script | changing it signs everyone out |
| `INTERNAL_API_TOKEN` | deploy script | shared by the API and KumoMTA |
| `POSTGRES_PASSWORD` | deploy script | changing it later also requires changing it inside Postgres |
| `PRIMARY_DOMAIN`, `BOUNCE_DOMAIN`, `MTA_HOSTNAME`, `SMTP_RELAY_HOSTNAME` | defaults | already the values in section 2 |
| `OPS_EMAIL` | you | alerts, unmatched payments, postmaster@ / abuse@ / dmarc@ mail |
| `MTA_WARMUP_START` | deploy script | first day of IP warm-up; clear it after day 20 |
| `MTA_STS_MODE` | deploy script | `testing`, then `enforce` (4.10) |
| `FALLBACK_SMTP_*` | optional | backup provider for mail above the warm-up cap; not needed at ~100/day |
| `MPESA_*` | you | section 4.5; full reference in `docs/BILLING_AND_PAYMENTS.md` |
| `BILLING_*` | optional | tax, grace days (7), renewal notice (3 days) |
| `GOOGLE_CLIENT_ID/SECRET` | optional | Google sign-in |
| `EMAIL_CONTENT_RETENTION_DAYS` (30), `EMAIL_RECORD_RETENTION_DAYS` (395) | defaults | plans can keep logs for less time |
| `RATE_LIMIT_PER_MINUTE` (600), `SANDBOX_DAILY_LIMIT` (50) | defaults | per API key, and for the sandbox sender |

After editing `.env`, run `$DC up -d`. Compose restarts only the services whose settings
changed.

---

## 6. Operating TredMail

Every command assumes you are in `/opt/tredmail` and have defined:

```bash
DC="docker compose -f docker-compose.prod.yml --env-file .env -p tredmail-production --profile mta"
```

### 6.1 Deploying a new version

```bash
cd /opt/tredmail
git pull
$DC build
$DC run --rm --no-deps api npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
$DC up -d
curl -s https://api.tredmail.dovepeakdigital.com/health/ready
```

Running `bash deploy-hostinger.sh` again does the same, plus the OS update and checks. It is
safe to re-run: the existing `.env` is kept, the seed changes nothing that exists, and
M-Pesa registration is repeated.

Migrations only add things; the database keeps working during the brief restart. Queued
email waits safely in Postgres while the worker restarts.

### 6.2 Logs and status

```bash
$DC ps                          # status of every container
$DC logs -f --tail=200 api      # or worker, kumomta, smtp-relay, caddy, console
$DC logs worker | grep -i "ALERT\|billing\|monitor"
```

Where to look first:
- **Delivery problems:** the console's Emails page (each email shows its event timeline and
  SMTP response), then `$DC logs kumomta`.
- **Payments:** Back-office → Gateway log and Payments, then `$DC logs api | grep -i payment`.
- **Alerts:** the worker emails `OPS_EMAIL` about high bounce or complaint rates, delivery
  delays, blocklist listings, missing delivery results, workspaces paused by the circuit
  breaker, and unmatched payments.

### 6.3 Backups (set this up on day one)

Back up the database every night and keep 14 days. Create `/etc/cron.d/tredmail-backup`
with this content:

```
30 1 * * * root cd /opt/tredmail && mkdir -p /var/backups/tredmail && docker compose -f docker-compose.prod.yml --env-file .env -p tredmail-production exec -T postgres pg_dump -U tredmail -Fc tredmail > /var/backups/tredmail/tredmail-$(date +\%F).dump && find /var/backups/tredmail -name '*.dump' -mtime +14 -delete
```

**Also:**
- Copy the dumps off the server, for example to Hostinger backups, an S3 bucket or Google
  Drive, with `rclone`. A backup kept only on the same disk does not survive the server.
- Keep `.env` in your password manager. Without its `TREDMAIL_MASTER_ENCRYPTION_KEY`, a
  database backup cannot decrypt the DKIM keys.
- Turn on Hostinger's weekly VPS snapshots as a second layer.

**Restore** (onto a fresh server deployed with the **same** `.env`):

```bash
$DC up -d postgres
$DC exec -T postgres pg_restore -U tredmail -d tredmail --clean --if-exists < tredmail-YYYY-MM-DD.dump
$DC up -d
```

### 6.4 Routine tasks

| Task | How |
| --- | --- |
| Grant or remove back-office access | `$DC run --rm --no-deps api node apps/api/dist/cli/staff.js grant\|revoke\|list <email>` |
| Revoke a leaked API key | `$DC run --rm --no-deps api node apps/api/dist/cli/revoke-api-key.js tred_live_...` |
| Run billing immediately | Back-office → Workspaces → "Run billing now" |
| Assign a till payment | Back-office → Payments → "Unmatched only" → Assign |
| Enterprise customer (custom price and limits) | Back-office → workspace → Set plan |
| Bank transfer received | Back-office → workspace → Record payment |
| Resume a workspace paused for bounces | Back-office → workspace → Resume sending (after the customer cleans their list) |
| Suspend an abusive workspace | Back-office → workspace → Suspend |
| Change plan prices | Back-office → Plans (applies to new invoices) |
| Certificates | Automatic: Caddy renews them, and `cert-sync.sh` (cron, 03:17 and 15:17) passes them to KumoMTA and the relay |
| Disk space | `df -h`; `docker system prune -f` removes old images after deploys |

### 6.5 Scaling notes

- At Dovepeak's volumes (100 to 3,000 emails a day) one KVM 4 is ample.
- **Move attachments to object storage** before external customers send heavy attachments at
  volume. They currently live in Postgres.
- **Add a second sending IP** for free and new accounts before opening public sign-ups widely,
  so one bad customer cannot affect Dovepeak's own reputation.
- Staging needs **its own server**: both stacks bind ports 80 and 443.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A service keeps restarting, and the log says `Invalid TredMail configuration` | a bad `.env` value | the log names the variable; fix it, then `$DC up -d` |
| Browser shows a certificate error | the A record is missing or wrong, so Caddy could not get a certificate | check DNS (4.2), then `$DC restart caddy` and watch `$DC logs caddy` |
| Emails stay `sent` and never become `delivered` | KumoMTA cannot report back, or outbound port 25 is blocked | `$DC logs kumomta`; check that `INTERNAL_API_TOKEN` is the same for api and kumomta; ask Hostinger about port 25 |
| Gmail puts mail in spam | PTR, SPF, DKIM or DMARC is not aligned, or warm-up is too fast | check "Show original" in Gmail; records 4 to 13; PTR (4.6) |
| `domain_not_verified` on send | the customer's DNS records are not published yet | the domain page shows what is missing; press Verify |
| `monthly_quota_exceeded` or `daily_limit_exceeded` | the workspace reached its plan limits | upgrade the plan, or set custom limits in the back-office |
| M-Pesa prompt not received | wrong short code and passkey pair, an unapproved app, or the phone is not Safaricom | `$DC logs api \| grep -i mpesa`; Back-office → Payments shows the failure message |
| Payment taken but invoice still open | the callback was missed | the reconciler checks every minute; otherwise see Back-office → Gateway log, or record the payment by hand |
| Back-office says "two-factor required" | staff in production need 2FA | Settings → Security → enable 2FA |
| Customer says they are locked out of SMTP | 10 failed logins from one IP lock it for 15 minutes | wait, and make sure they use a valid API key as the password |

---

## 8. Local development

Requires Node 22 or later, Docker and Python 3 (only for the Python SDK tests).

```bash
npm install && npm install --prefix apps/console
cp .env.example .env                       # fill TREDMAIL_MASTER_ENCRYPTION_KEY and BETTER_AUTH_SECRET (openssl rand -hex 32)
docker compose up -d                       # Postgres :5435, Redis :6389, Mailpit :1035 (web UI http://localhost:8035)
npm run db:migrate && npm run db:seed      # prints the dev owner password and API key
npm run dev:all                            # API :3000, worker, console http://localhost:3010
```

**Rules for development:**
- **Never put production M-Pesa keys in a local `.env`:** they send real PIN prompts. Use the
  simulator instead:
  - run `npm run payments:simulator`;
  - set `MPESA_BASE_URL=http://localhost:4010` and dummy `MPESA_CONSUMER_KEY`,
    `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE=174379` and `MPESA_PASSKEY`.
- All mail goes to Mailpit, never to the internet.

**Checks before a release:**

```bash
npm run typecheck && npm run lint && npm test
npm run build:console
npm run openapi:export        # after changing packages/core/src/openapi/spec.ts
npm run test:smoke            # against the running dev stack; also test:accounts, test:delivery, test:developer
```

**Changing the database:** edit `packages/db/prisma/schema.prisma`, then run
`npm run db:migrate -- --name <change>`, and commit the new folder under
`packages/db/prisma/migrations`. Production applies it on the next deploy (6.1).

---

## 9. Go-live checklist

- [ ] Hostinger: port 25 out and 25/587/465 in opened, PTR = `mta1.tredmail.dovepeakdigital.com`
- [ ] Namecheap: records 1 to 12, 14 to 16 and 19 added and resolving
- [ ] First deploy done; owner password and Dovepeak API key saved
- [ ] `.env` backed up in a password manager
- [ ] Record 13 (DKIM) added from the seed output
- [ ] `.env` completed: `OPS_EMAIL`, M-Pesa, billing; `$DC up -d`; `payments-setup` run
- [ ] Health, PTR, and the `mta1` and `smtp` certificates verified (4.6), then records 17 and 18 added
- [ ] Owner password changed, 2FA on, domains verified, test email received with DKIM pass
- [ ] Nightly database backup cron installed, and copies leave the server
- [ ] Live M-Pesa payment and refund tested
- [ ] Production M-Pesa keys removed from developer machines
- [ ] Dovepeak applications moved one by one; old providers cancelled after a clean week
- [ ] After two weeks: MTA-STS `enforce`, warm-up date cleared
- [ ] Before public sign-ups: terms of service, privacy policy and acceptable-use policy published; second IP for free accounts
