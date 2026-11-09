TredMail production readiness audit
Verdict: not ready to launch
A deploy fails today, and even once it's running, no email can be sent. Three bugs each stop the launch on their own. All three look like small fixes, but your current checks can't catch them. Typecheck, lint and all 134 unit tests pass, and the development and staging configs hide these bugs.

I built the real production images and ran the full stack in production mode, with all mail caught locally. I didn't change any code in the repo.

Launch blockers
#	Problem	What happens	Where
1	The deploy crashes on a fresh config. Compose passes empty strings for OPS_EMAIL and BILLING_SUPPORT_EMAIL, and the config check rejects them.	The script stops at encrypt-secrets, and the API and worker can't start either.	env.ts:79, env.ts:130, docker-compose.prod.yml:32
2	No email can be sent in production. KumoMTA offers STARTTLS with a self-signed certificate on port 2525. The worker rejects it, and only skips TLS in development or on the staging route.	Every send fails with self-signed certificate, including verification and password-reset emails. Emails retry for about 6 hours, then fail.	worker/index.ts:41
3	New customers get stuck in onboarding. After verifying their email, stale cached data sends them from /overview back to /onboarding.	The workspace is created, but the button spins forever. A hard reload before submitting avoids it.	workspace.tsx:87
4	Clearing the warm-up date crashes the app. The .env comment says to clear MTA_WARMUP_START after day 20, but an empty value is rejected.	Following that instruction stops the app restarting on day 20.	env.ts:86, docker-compose.prod.yml:36
Serious problems: fix before taking real customers
#	Problem	Impact	Where
5	DEGRADED domains can't send new mail. The API accepts only VERIFIED, though the docs say degraded domains keep sending.	One failed DNS re-check gives customers 403s. If it's your platform domain, password resets silently stop: the user sees success and no email is created.	email-service.ts:54, :106
6	A Redis outage hangs the API. The "fail open" limiter and "accept now, queue later" logic never run, because Redis commands wait forever.	POST /v1/emails and /health/ready hung past my 15-second limit, and the test email was never recorded.	redis.ts:5
7	Losing Redis data stops all background jobs. Schedules are only created when the worker starts.	The sweeper, billing, domain checks, retention and alerts stop until a restart, and /health/worker still reports OK.	monitor.ts:250
8	Emails waiting to retry can be lost for good. The sweeper skips SENDING, which is the status during retries.	My test email was still stuck about 7 hours after a Redis flush.	monitor.ts:224
9	Anyone can sign up and send from your only IP (open item H4). There's no approval step, and the circuit breaker only reacts after damage is done.	One spammer can get the IP blocklisted for every customer.	Not built
10	Customers can't install the SDKs (open item B7). The Node package is marked private, and the docs tell customers to install from /path/to/TredMail/....	Your public docs show instructions that can't work.	sdks page
11	No Terms or Privacy Policy pages turned up. I found none in the sign-up pages, and the billing mentions I saw didn't point to any.	This matters for a paid service handling other people's email, so check it with whoever handles your legal side.	Console
Smaller issues
SMTP relay (M1–M3 still open):
Requests skip API validation.
Split messages can drop recipients while the client still gets 250.
A retry during the first attempt can lose a message.
Status can go backwards: markSent always writes SENT, so a fast DELIVERED report can be overwritten (worker/index.ts:124). I saw this in the code but didn't reproduce it.
test:smoke fails: it still expects tracking on by default, and it's part of your release gate. The app is fine here; tracking worked when I turned it on explicitly.
Test mode doesn't exist (M9): tred_test_ keys behave like live keys.
.gitignore gaps: certs/ (private keys) and .env.staging aren't covered.
README overpromises: it advertises marketing email, but broadcasts (F2) aren't built, and neither is customer inbound email (F1). Either build them or remove the claim.
What works
With a temporary workaround for blockers 1 and 2:

Deploy pieces: images build, migrations apply with no schema drift, and the seed runs. npm audit is clean.
Routing: the Caddy config serves the right sites, /internal is blocked publicly, and the MTA-STS policy is served.
Integration suites:
Accounts and delivery pass in production mode (DKIM signing, delivery reports, bounces, complaints, suppression, relay refusal).
Developer passes, but in development mode, because it needs private webhook targets. That covers templates, idempotency, scheduling, relay, DMARC and webhook retries. I skipped its outbox step (see Other notes).
Console: 21 pages loaded in a real browser with no failed requests, script errors or CSP violations. Adding a domain, creating an API key and signing in all worked.
Not tested yet
These can only be proven on the real server:

Real inbox delivery to Gmail, Outlook, Yahoo and iCloud, including SPF, DKIM, DMARC and reputation.
M-Pesa: live or sandbox payments; I only read that code.
Backups: the encryption and upload steps have never been run.
Google sign-in.
Still to do outside the code
DNS: none of the 16 production records I checked exist yet, including console, api, mta1, SPF and DKIM.
Hostinger: port 25 needs opening and the PTR record set.
M-Pesa: get MPESA_ALLOWED_IPS from Safaricom. The API refuses to start with live M-Pesa without it.
Before go-live:
Set ALERT_WEBHOOK_URL, otherwise outage alerts depend on the mail server that's down.
Set the backup keys and remote.
Set up the uptime monitor.
Recommended order
Fix 1–4 and add a CI step that boots the production compose stack and sends an email, since that would have caught 1 and 2.
Fix 5–8.
Deploy to staging, set up DNS and the server, and run the release gate in docs/PRE_DEPLOYMENT_REMEDIATION.md.
Build 9–11 before opening public sign-ups.