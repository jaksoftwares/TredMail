# Running TredMail

This guide covers running TredMail on a development machine and running its checks. For
production, see `PRODUCTION_RUNBOOK.md` and `deploy-hostinger.sh`.

## What you need

- Node.js 22 or later (the root `package.json` requires it, and CI uses 22).
- Docker, for PostgreSQL, Redis and Mailpit (and KumoMTA when you test delivery).
- `openssl`, to generate secrets.

## First run

1. **Configure.** Copy `.env.example` to `.env` and set the three secrets, each to the output of
   `openssl rand -hex 32`:
   - `TREDMAIL_MASTER_ENCRYPTION_KEY`
   - `INTERNAL_API_TOKEN`
   - `BETTER_AUTH_SECRET`

   Blank values are treated as unset, so you can leave the other variables empty. To test
   webhooks against `localhost`, set `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`.

2. **Start the backing services.**

   ```bash
   docker compose up -d
   ```

   This starts PostgreSQL on port 5435, Redis on 6389 and Mailpit on 8035 (web inbox) and 1035
   (SMTP). The compose file also defines KumoMTA, which is off until you ask for it.

3. **Install, migrate and seed.**

   ```bash
   npm install
   npm install --prefix apps/console
   npm run db:deploy
   npm run db:seed
   ```

   `db:seed` prints an owner login and an API key once. Save them. The seed creates two
   workspaces: the platform workspace, which owns `tredmail.dovepeakdigital.com` and sends account
   email and the sandbox mail, and the Dovepeak workspace. In development both domains are marked
   verified, so mail goes to Mailpit.

4. **Run everything.**

   ```bash
   npm run dev:all
   ```

   This starts the API, the worker and the console together. Use `npm run dev` for the API and
   worker only.

| Service | Address |
| --- | --- |
| Console | http://localhost:3010 (sign in with the seeded owner, or create an account) |
| API | http://localhost:3000 (`/health` for liveness, `/health/ready` for readiness) |
| Mailpit inbox | http://localhost:8035 (verification and test emails arrive here) |

To run the SMTP relay as well, use `npm run dev:smtp` with `SMTP_RELAY_PORT=2587` in `.env`.

## Running the parts separately

Each app can run on its own, which is useful when you change one of them.

| Command | Starts |
| --- | --- |
| `npm run dev:api` | the API on port 3000 |
| `npm run dev:worker` | the delivery worker (sends queued mail, runs schedules and webhooks) |
| `npm run dev:console` | the console on port 3010 |
| `npm run dev:smtp` | the SMTP relay on `SMTP_RELAY_PORT` |
| `npm run build` | production builds of the API, worker and relay |
| `npm run build:console` | the console build, which also type-checks it |

The API and the worker must both be running for mail to be delivered.

## Delivery through KumoMTA

By default the worker delivers to Mailpit, so nothing leaves your machine. To test the real
delivery path, start KumoMTA and point the worker at it:

```bash
docker compose --profile mta up -d
```

Then set `SMTP_HOST=localhost` and `SMTP_PORT=2525` in `.env` and restart the worker. KumoMTA's
policy is in `mta/policy/init.lua`.

## Test and check commands

Run the unit tests and static checks first. They need no running services, so they work on any
machine:

```bash
npm run typecheck && npm run lint && npm test
```

The same three commands run in CI (`.github/workflows/ci.yml`), together with a secret scan, an
audit of production dependencies, and a check that the migrations apply cleanly and match the
schema.

End-to-end scripts run against a live API. They need an API key from the seed, or one you created
in the console:

```bash
TREDMAIL_API_KEY=tred_live_... npm run test:smoke      # send, worker, Mailpit, tracking links
npm run test:accounts                                  # sign-up, workspaces, sandbox, invitations, roles
TREDMAIL_API_KEY=tred_live_... npm run test:delivery   # KumoMTA: delivered, bounced, complained (needs --profile mta)
TREDMAIL_API_KEY=tred_live_... npm run test:developer  # templates, idempotency, scheduling, SMTP relay, webhooks
```

`test:delivery` also needs KumoMTA running, as above.

Other checks:

- `npm run openapi:export` regenerates the OpenAPI document the console and docs use. Run it after
  you change an API schema.
- `npm run db:generate` regenerates the Prisma client after a schema change.
- `npx prisma migrate diff --from-migrations packages/db/prisma/migrations --to-schema-datamodel packages/db/prisma/schema.prisma --shadow-database-url <url>`
  confirms that the migrations match the schema. Use a throwaway database for the shadow URL.

## Staff and operations commands

- `npm run staff -- grant you@example.com` gives a signed-up user access to the back-office at
  `/admin`. `revoke` and `list` work the same way. The person must sign up first.
- `npm run keys:revoke -- <key>` revokes an API key.
- `npm run payments:setup` and `npm run payments:simulator` set up and simulate M-Pesa (Daraja).

## Common problems

- **"Invalid TredMail configuration"** at start-up: the message names the variable. Fix it in
  `.env`. Blank optional variables are fine.
- **Mail stays queued:** the worker is not running, or Redis is down. `/health/worker` on the API
  shows the worker's last heartbeat.
- **Webhook refused for `localhost`:** set `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (development only).
- **Relay refuses logins over plain text:** the relay allows plain-text authentication only when
  `NODE_ENV=development`.
- **Port already in use:** change the host port in `docker-compose.yml`, and the matching
  variable in `.env`.
