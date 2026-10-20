# Phase 2 report: delivery engine

**Status:** the code is complete and tested on a development machine. The phase gate has two
parts:

1. **"Delivered status matches the mail server's logs"**: proven locally (see Verification).
2. **"Test emails land in Gmail and Outlook inboxes"**: can only be checked on the live
   server, after the go-live checklist below.

## What Phase 2 adds

| Area | What it does | Where |
| --- | --- | --- |
| Mail server | KumoMTA 2026.09.29 runs in Docker. The worker hands it DKIM-signed mail on internal port 2525. It delivers on port 25 with HELO `mta1.tredmail.dovepeakdigital.com` and opportunistic TLS, retrying temporary failures for 72 hours. | `mta/policy/init.lua`, `docker-compose.prod.yml` |
| Pacing per provider | Gmail 600 an hour; Microsoft, Yahoo and iCloud 300 an hour; others limited to 5 connections each. | `init.lua` (`PROVIDER_LIMITS`) |
| Bounce matching (VERP) | Each email gets its own signed return address (`b-<id>-<signature>@bounces...`). Forged bounces are ignored. | `packages/core/src/mail/verp.ts` |
| Real delivery statuses | KumoMTA reports every attempt to the API. Emails move from SENT to DELIVERED, DEFERRED, BOUNCED or FAILED, with webhooks (`email.deferred` is new). | `apps/api/src/routes/mta.ts`, `services/delivery-events.ts` |
| Bounce reports and complaints | Bounce reports (DSNs), plain-text bounces and spam complaints (ARF) sent back to port 25 are parsed and applied. | `mail/report-parser.ts`, `services/inbound-mail.ts` |
| Suppression rules | Unknown users and non-existent domains are suppressed, and so is every spam complaint. Spam blocks, policy blocks, content rejections and full mailboxes are **not** suppressed: they point at our reputation, not at a bad address. | `mail/bounce-classifier.ts` |
| Postmaster mail | Mail to `postmaster@`, `abuse@`, `dmarc@` and other addresses at `tredmail.dovepeakdigital.com` (and at `mta1...`) is forwarded to `OPS_EMAIL`, up to 200 a day. | `inbound-mail.ts` |
| Warm-up and fallback | A 20-day daily cap (150 rising to 10,000). Mail above the cap goes to an optional backup provider, or waits until the next day; it is never dropped. | `delivery/warmup.ts`, worker |
| Health alerts | Checked every 15 minutes, emailed to `OPS_EMAIL`: bounce rate, complaint rate, delays, missing delivery results, blocklists (Spamhaus, SpamCop, Barracuda), `mta1` DNS. | `apps/worker/src/monitor.ts` |
| Data retention | Every day at 02:30 UTC, message bodies older than 30 days are erased, and emails with their events are deleted after 13 months. | `monitor.ts` (`applyRetention`) |
| Gmail feedback | A `Feedback-ID` header on every message, so Postmaster Tools reports spam rates per category and workspace. | worker |
| Console | The email detail page shows the recipient, bounce category, suppression, diagnostic, and warm-up holds or fallback use. | `apps/console` |
| Company details | Account-email footers carry the Juja Square postal address. | `packages/core/src/config/company.ts` |
| Hardening | `/internal/*` is blocked at Caddy. The public port 25 never relays. Port 2525 is not published. | `Caddyfile`, `init.lua` |

## Verification

- **Code checks:** typecheck is clean and lint has 0 errors. All 56 unit tests pass, 14 of them new: VERP, bounce classification, report parsing and the warm-up schedule. The console builds.
- **End-to-end test** (`npm run test:delivery`), run through a real KumoMTA. All seven checks passed:
  1. An email reached DELIVERED from KumoMTA's own log.
  2. A bounce report marked the email BOUNCED and suppressed the recipient.
  3. A reputation block bounced but didn't suppress.
  4. A forged bounce was ignored.
  5. A spam complaint marked the email COMPLAINED and suppressed the recipient.
  6. Mail to `postmaster@` was forwarded.
  7. An attempt to relay to gmail.com was refused with 550.
- **Phase 1 tests:** the smoke and accounts tests still pass with KumoMTA in the path.
- **Warm-up, run by hand:**
  - With the cap reached and no backup provider, the email was held with the reason `warmup_cap_reached`.
  - With a backup provider configured, the same email went through it.
- **Maintenance jobs:** the health checks and the retention job ran against the dev database without errors.

## Go-live checklist (in order)

1. **Namecheap:** add records 1 to 12 from `docs/PRODUCTION_INFRASTRUCTURE.md` section 4. Leave every Zoho record exactly as it is.
2. **Hostinger:** send the support request in section 2 (ports 25 in and out, PTR set to `mta1.tredmail.dovepeakdigital.com`). Wait until `dig -x <SERVER_IP>` shows that name.
3. **Zoho:** create the operations mailbox or alias, for example `ops@dovepeakdigital.com`. Allow mail from `no-reply@tredmail.dovepeakdigital.com`.
4. **Server:** on the VPS, run `OPS_EMAIL=ops@dovepeakdigital.com CONSOLE_DOMAIN=console.tredmail.dovepeakdigital.com API_DOMAIN=api.tredmail.dovepeakdigital.com TRACKING_DOMAIN=track.tredmail.dovepeakdigital.com ./deploy-hostinger.sh`.
   - It checks the PTR and port 25, opens port 25 in the firewall, and generates `.env` with all secrets and today as the warm-up start.
   - Back up `.env` somewhere safe. Losing `TREDMAIL_MASTER_ENCRYPTION_KEY` makes every DKIM key unrecoverable.
5. **DKIM:** sign in with the owner login the seed prints and change the password. Then go to TredMail Platform → Domains → `tredmail.dovepeakdigital.com`, add record 13 (DKIM) at Namecheap, and press Verify.
6. **Inbox tests (the second half of the gate):** send test emails from the API to a Gmail, an Outlook.com and a Yahoo address.
   - Check that each lands in the inbox.
   - In Gmail, use "Show original" to confirm SPF, DKIM and DMARC all show PASS.
   - On the console, check that each email reaches *delivered*.
7. **Sender programs:** register Google Postmaster Tools, Microsoft SNDS and JMRP, and the Yahoo complaint feedback loop (guide section 6).
8. **Week 3 to 4:** if the DMARC reports forwarded to `OPS_EMAIL` show everything passing, change record 11 to `p=quarantine`. After day 20, clear `MTA_WARMUP_START`.
9. **Dovepeak's own domain:** when Dovepeak apps start sending as `@dovepeakdigital.com`, add the optional records in section 4. That includes adding TredMail's include to Zoho's existing SPF record.

At ~100 emails a day you don't need a backup provider: day 1's cap is already 150.

## Not done in Phase 2, and why

| Item | Reason | When |
| --- | --- | --- |
| MTA-STS for `tredmail.dovepeakdigital.com` | KumoMTA needs a real certificate first, or strict senders would refuse bounce reports. TLS-RPT (reports only) is already in the DNS list. | Phase 3 |
| Staging "real delivery to approved addresses" | Staging catches all mail in Mailpit, which is safe. Real delivery from staging needs its own route through the production KumoMTA. | Phase 3 |
| Events for mail sent through the backup provider | That mail stays at SENT, because the other provider's webhooks aren't collected. It only matters if the warm-up cap is ever exceeded. | If a backup provider is used |
| DMARC report parsing | The reports are forwarded raw (compressed XML) to `OPS_EMAIL`. A DMARC report dashboard is a later addition. | Phase 3 |
| Second IP and IPv6 | One IPv4 address is enough for 3,000 a day. A second IP is one more pool entry in `init.lua`, its address added to SPF record 7, and its own PTR. | When volume or marketing mail needs it |

## Notes

- **Your dev processes:** during testing, one of my cleanup commands also stopped your running `npm run dev` API and worker. I updated the timestamps of their two entry files (no content change), your `tsx watch` restarted them, and they are back on port 3000.
- **Testing alongside your dev server:** if you keep your own dev worker running, the delivery test has to run in isolation, because your worker shares the queue and sends straight to Mailpit. Run it with `PORT=3002 REDIS_URL=redis://localhost:6389/1` for the API and worker, and `KUMOMTA_API_URL=http://host.docker.internal:3002` when starting KumoMTA. The README describes the simpler case.
- **Open items from earlier phases:**
  - Ask GitHub Support to purge the leaked key from history.
  - Delete the stale branches `dev`, `prod`, `test` and `backup/...`.
