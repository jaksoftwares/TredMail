# TredMail production infrastructure: server, reverse DNS and DNS records

This is the setup checklist for running TredMail, including its own mail server (KumoMTA), on
one Hostinger KVM 4 VPS, with DNS for `dovepeakdigital.com` hosted at Namecheap.

Replace `<SERVER_IP>` everywhere below with the VPS's public IPv4 address (hPanel → VPS →
Overview). TTL: leave Namecheap's **Automatic** unless stated.

## 1. The server

| Item | Value |
| --- | --- |
| Provider and plan | Hostinger KVM 4: 4 vCPU, 16 GB RAM, 200 GB NVMe, 16 TB bandwidth |
| OS | Ubuntu 24.04 LTS |
| Runs | Caddy (80/443), console, API, worker, Postgres, Redis, KumoMTA (25) |
| Mail server name | `mta1.tredmail.dovepeakdigital.com` |

One KVM 4 comfortably runs the whole stack at Dovepeak's volumes. KumoMTA sends over IPv4 only
at first: Gmail and Microsoft are stricter with IPv6 senders, and IPv4 needs only one PTR record.

### Hostnames

| Hostname | Purpose |
| --- | --- |
| `console.tredmail.dovepeakdigital.com` | Web console |
| `api.tredmail.dovepeakdigital.com` | Public REST API for applications and SDKs |
| `track.tredmail.dovepeakdigital.com` | Open and click tracking links inside emails |
| `tredmail.dovepeakdigital.com` | TredMail's own sending domain (`no-reply@`, `onboarding@`) |
| `bounces.tredmail.dovepeakdigital.com` | Return-Path domain; bounce reports come back here |
| `mta1.tredmail.dovepeakdigital.com` | The mail server itself (its HELO name and PTR) |
| `smtp.tredmail.dovepeakdigital.com` | SMTP relay for applications (ports 587 and 465) |
| `mta-sts.tredmail.dovepeakdigital.com` | MTA-STS policy for the sending domain |
| `mta-sts.bounces.tredmail.dovepeakdigital.com` | MTA-STS policy for the bounce domain |

These go into the server's `.env` as:

```
CONSOLE_DOMAIN=console.tredmail.dovepeakdigital.com
API_DOMAIN=api.tredmail.dovepeakdigital.com
TRACKING_DOMAIN=track.tredmail.dovepeakdigital.com
PRIMARY_DOMAIN=tredmail.dovepeakdigital.com
BOUNCE_DOMAIN=bounces.tredmail.dovepeakdigital.com
```

## 2. Request to Hostinger support

Open a ticket or live chat from hPanel and send the text below (fill in the IP).

> Subject: Open outbound SMTP port 25 and set reverse DNS for VPS <SERVER_IP>
>
> Hello,
>
> We run our own transactional email server on our KVM 4 VPS (IP <SERVER_IP>), for account
> emails such as sign-up confirmations, password resets and receipts sent by Dovepeak
> Technologies' own applications. It is not used for bulk or unsolicited mail.
>
> Please could you:
>
> 1. Allow outbound TCP port 25 (SMTP) from this VPS, so the server can deliver mail to
>    recipients' mail servers.
> 2. Allow inbound TCP port 25, so it can receive bounce reports for our bounce domain,
>    and inbound TCP ports 587 and 465 for our authenticated SMTP submission service.
> 3. Set the reverse DNS (PTR) record of <SERVER_IP> to `mta1.tredmail.dovepeakdigital.com`,
>    if we cannot set it ourselves in hPanel. The forward record
>    `mta1.tredmail.dovepeakdigital.com → <SERVER_IP>` is already published.
>
> Our setup follows sending best practice: SPF, DKIM and DMARC on the sending domain, a
> matching PTR and HELO name, automatic handling of bounces and spam complaints with
> suppression lists, gradual IP warm-up, and monitored postmaster@ and abuse@ addresses.
>
> Thank you,
> Dovepeak Technologies

Publish the `mta1` A record (section 4) **before** asking for the PTR: providers usually check
that the forward record exists first.

### Checking it worked (run on the VPS)

```bash
# Outbound 25: should print "succeeded" / "open"
nc -vz -w 5 gmail-smtp-in.l.google.com 25

# PTR: should print mta1.tredmail.dovepeakdigital.com.
dig -x <SERVER_IP> +short

# Forward record matches: should print <SERVER_IP>
dig mta1.tredmail.dovepeakdigital.com A +short
```

`deploy-hostinger.sh` runs the port 25 and PTR checks on every deploy.

## 3. Reverse DNS (PTR), explained

Normal DNS turns a name into an address: `mta1.tredmail.dovepeakdigital.com → <SERVER_IP>`.
Reverse DNS goes the other way: it answers "which name belongs to `<SERVER_IP>`?"

When our server connects to Gmail or Outlook to deliver a message, the receiving server only
sees the connecting IP address. Before accepting the message it:

1. looks up the PTR record of that IP and gets a name;
2. looks up that name's A record and checks it points back to the same IP
   (this round trip is called **forward-confirmed reverse DNS**);
3. compares the name with the one our server announced when it said hello (the **HELO**).

If the PTR is missing, generic (such as `srv123.hstgr.cloud`), or does not match, Gmail and
Microsoft reject the message or send it to spam. All three must agree:

| Check | Value |
| --- | --- |
| PTR of `<SERVER_IP>` | `mta1.tredmail.dovepeakdigital.com` |
| A record of `mta1.tredmail.dovepeakdigital.com` | `<SERVER_IP>` |
| HELO name KumoMTA announces | `mta1.tredmail.dovepeakdigital.com` |

**Why the PTR is set at Hostinger, not Namecheap:** reverse records live with whoever owns the
IP address block. Hostinger owns the VPS's IP, so the PTR is set in hPanel (VPS → Settings →
the IP address's PTR / reverse DNS option) or by Hostinger support. Namecheap only holds the
forward records for our domain.

## 4. Namecheap DNS

### Nameservers

Keep DNS at Namecheap. In Namecheap → Domain List → `dovepeakdigital.com` → **Domain** tab →
**Nameservers**, select **Namecheap BasicDNS**. That uses:

```
dns1.registrar-servers.com
dns2.registrar-servers.com
```

There is nothing to add if BasicDNS is already selected. Do not switch to Hostinger's
nameservers: every record below would then have to be recreated at Hostinger.

All records are added in **Advanced DNS → Host Records**. Namecheap's **Host** field is
relative to `dovepeakdigital.com`: enter `api.tredmail`, not `api.tredmail.dovepeakdigital.com`.

### Zoho Mail stays as it is

`dovepeakdigital.com` receives its mail through **Zoho Mail**, so **Advanced DNS → Mail
Settings** is already on **Custom MX** with Zoho's rows for host `@` (for example `mx.zoho.com`
10, `mx2.zoho.com` 20, `mx3.zoho.com` 50; the names end in `.eu` or `.in` if the Zoho account
is hosted there). **Do not change or remove any Zoho row** (MX, `zmail._domainkey` DKIM, the
`@` SPF, any `_dmarc` record). TredMail only adds records on the `tredmail` subdomain, which
Zoho never uses, so the two do not interact: staff mail keeps going through Zoho, application
mail goes through TredMail.

### Records to add now

| # | Type | Host | Value | Priority / notes |
| --- | --- | --- | --- | --- |
| 1 | A | `console.tredmail` | `<SERVER_IP>` | Console |
| 2 | A | `api.tredmail` | `<SERVER_IP>` | API |
| 3 | A | `track.tredmail` | `<SERVER_IP>` | Tracking links |
| 4 | A | `mta1.tredmail` | `<SERVER_IP>` | Mail server; must match the PTR |
| 5 | MX | `bounces.tredmail` | `mta1.tredmail.dovepeakdigital.com` | Priority 10. Bounce reports |
| 6 | MX | `tredmail` | `mta1.tredmail.dovepeakdigital.com` | Priority 10. postmaster@, abuse@, DMARC and TLS reports |
| 7 | TXT | `_spf.tredmail` | `v=spf1 ip4:<SERVER_IP> -all` | The one list of TredMail's sending IPs |
| 8 | TXT | `tredmail` | `v=spf1 include:_spf.tredmail.dovepeakdigital.com ~all` | SPF of the sending domain |
| 9 | TXT | `bounces.tredmail` | `v=spf1 include:_spf.tredmail.dovepeakdigital.com ~all` | SPF of the Return-Path domain (the one receivers actually check) |
| 10 | TXT | `mta1.tredmail` | `v=spf1 a -all` | SPF for the HELO name |
| 11 | TXT | `_dmarc.tredmail` | `v=DMARC1; p=none; rua=mailto:dmarc@tredmail.dovepeakdigital.com; adkim=r; aspf=r; pct=100` | Start at `p=none`; see below |
| 12 | TXT | `_smtp._tls.tredmail` | `v=TLSRPTv1; rua=mailto:tls-reports@tredmail.dovepeakdigital.com` | TLS failure reports |
| 13 | TXT | `tredmail._domainkey.tredmail` | *the DKIM value shown in the console* | See below |
| 14 | A | `smtp.tredmail` | `<SERVER_IP>` | SMTP relay for applications |
| 15 | A | `mta-sts.tredmail` | `<SERVER_IP>` | Serves the MTA-STS policy |
| 16 | A | `mta-sts.bounces.tredmail` | `<SERVER_IP>` | Serves the MTA-STS policy for the bounce domain |
| 17 | TXT | `_mta-sts.tredmail` | `v=STSv1; id=20261101` | Add after the first deploy (see below) |
| 18 | TXT | `_mta-sts.bounces.tredmail` | `v=STSv1; id=20261101` | Add after the first deploy |
| 19 | TXT | `*._report._dmarc.tredmail` | `v=DMARC1` | Lets customers' DMARC reports reach dmarc@ (RFC 7489 external destination) |

Record 8 is what the console's Domains page expects for `tredmail.dovepeakdigital.com`. When
a second sending IP is added later, only record 7 changes.

**Record 13 (DKIM)** is generated by TredMail, so it cannot be listed in advance. After the
first deploy and `npm run db:seed`, sign in to the console as the owner, switch to the
**TredMail Platform** workspace, open **Domains → tredmail.dovepeakdigital.com**, and copy the
DKIM value (it starts with `v=DKIM1; k=rsa; p=`). Namecheap accepts the long value in one
field. Then press **Verify** on the same page.

**Record 11 (DMARC):** keep `p=none` for the first 2 to 4 weeks while reports confirm every
message passes SPF and DKIM, then change it to `p=quarantine`. Verification accepts any policy.

### MTA-STS and the mail server's certificate (records 14 to 18)

MTA-STS tells *other* servers to require TLS with a valid certificate when they deliver mail
*to* TredMail's domains (bounce reports, complaints, postmaster mail). It needs KumoMTA to
present a real certificate, so the order matters:

1. Publish records 14 to 16 with the others. Caddy then obtains Let's Encrypt certificates for
   `mta1`, `smtp`, `mta-sts.tredmail` and `mta-sts.bounces.tredmail` on the first deploy.
2. `deploy-hostinger.sh` runs `scripts/cert-sync.sh`, which copies the `mta1` and `smtp`
   certificates to KumoMTA (STARTTLS on port 25) and the SMTP relay, and installs a cron job
   that repeats this twice a day (Let's Encrypt renews every ~60 days; KumoMTA is restarted
   only when its certificate changes).
3. Check KumoMTA presents the real certificate:
   `openssl s_client -connect mta1.tredmail.dovepeakdigital.com:25 -starttls smtp | grep subject`
   should show `CN = mta1.tredmail.dovepeakdigital.com`.
4. Then add records 17 and 18. The policy starts in `testing` mode (`MTA_STS_MODE=testing`):
   failures are only reported to `tls-reports@` (record 12), nothing is refused.
5. After two weeks of clean TLS reports, set `MTA_STS_MODE=enforce` in `.env`, restart Caddy
   (`docker compose ... restart caddy`), and change the `id=` in records 17 and 18 to a new
   value (for example today's date) so senders fetch the new policy.

Record 19 is needed because customers' DMARC records send reports to
`dmarc@tredmail.dovepeakdigital.com`, a different domain from theirs: receivers only deliver
such reports when TredMail's DNS confirms it accepts them.

### Optional: Dovepeak's own applications sending as `@dovepeakdigital.com`

Only needed when Dovepeak applications send from addresses like `billing@dovepeakdigital.com`
(the seed adds this domain to the Dovepeak workspace). The console's Domains page lists the
exact values; in Namecheap they are:

| Type | Host | Value |
| --- | --- | --- |
| TXT | `tredmail._domainkey` | *DKIM value from the console* |
| TXT | `@` | add `include:_spf.tredmail.dovepeakdigital.com` to the **existing** SPF record |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@tredmail.dovepeakdigital.com` (only if none exists) |
| CNAME | `bounces` | `bounces.tredmail.dovepeakdigital.com` |

A domain may have only **one** SPF record, and `@` already has Zoho's. Add TredMail to that
same record rather than creating a second one, keeping Zoho's include exactly as it is now:

```
v=spf1 include:zohomail.com include:_spf.tredmail.dovepeakdigital.com ~all
```

(Use `include:zoho.com`, `zoho.eu` or whichever form the record already has.) If `_dmarc`
already exists from the Zoho setup, keep it and do not add a second one.

### Checking the records

```bash
dig console.tredmail.dovepeakdigital.com A +short
dig bounces.tredmail.dovepeakdigital.com MX +short
dig _spf.tredmail.dovepeakdigital.com TXT +short
dig tredmail.dovepeakdigital.com TXT +short
dig _dmarc.tredmail.dovepeakdigital.com TXT +short
dig tredmail._domainkey.tredmail.dovepeakdigital.com TXT +short
```

Namecheap changes usually appear within 30 minutes.

## 5. IP warm-up

The VPS has existed for two months, but its IP has no history of sending email, so mailbox
providers treat it as new. `deploy-hostinger.sh` sets `MTA_WARMUP_START` to the first deploy
day, and the worker caps what goes through KumoMTA each day (UTC):

| Days | 1-2 | 3-4 | 5-6 | 7-8 | 9-10 | 11-12 | 13-14 | 15-16 | 17-18 | 19 | 20 | 21+ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cap per day | 150 | 300 | 600 | 1,000 | 1,500 | 2,000 | 3,000 | 4,500 | 6,000 | 8,000 | 10,000 | no cap |

At today's ~100 emails a day the cap never binds, so **no fallback provider is needed**. If
volume jumps during warm-up, mail above the cap either goes through `FALLBACK_SMTP_*` (when
set) or waits for the next day's allowance; it is never dropped. KumoMTA also paces each
provider separately (Gmail 600/h, Microsoft, Yahoo and iCloud 300/h; `mta/policy/init.lua`).
After day 20, clear `MTA_WARMUP_START` in `.env`.

## 6. Mailbox provider programs (feedback loops and reputation)

Register once the server is sending. Each one is free and needs someone at Dovepeak to sign in.
Complaint reports go to `fbl@tredmail.dovepeakdigital.com`; TredMail reads them automatically
and suppresses the complaining recipient.

1. **Google Postmaster Tools** (postmaster.google.com): add `tredmail.dovepeakdigital.com`,
   then add the `google-site-verification=...` TXT record Google shows at host `tredmail`
   (a second TXT next to the SPF is fine). Gmail sends no complaint emails; instead the
   dashboard shows spam rate, reputation and authentication, broken down by the
   `Feedback-ID` header TredMail puts on every message.
2. **Microsoft SNDS** (sendersupport.olc.protection.outlook.com/snds): request access for
   `<SERVER_IP>`. Microsoft emails a confirmation link to an address such as
   `postmaster@mta1.tredmail.dovepeakdigital.com`; TredMail forwards that to `OPS_EMAIL`.
3. **Microsoft JMRP** (same site, "Junk Mail Reporting Program"): enrol `<SERVER_IP>` with
   `fbl@tredmail.dovepeakdigital.com` as the report address.
4. **Yahoo Complaint Feedback Loop** (senders.yahooinc.com): sign in with a Yahoo account,
   verify `tredmail.dovepeakdigital.com` (DKIM domain), report address
   `fbl@tredmail.dovepeakdigital.com`. Add `dovepeakdigital.com` too once Dovepeak apps send
   from it.

Watch Postmaster Tools weekly during warm-up: domain and IP reputation should reach "High"
and the spam rate stay under 0.1%. TredMail's own alert fires at 0.1%; Gmail filters above 0.3%.

## 7. Operations mailbox

Set `OPS_EMAIL` in the server's `.env` to a monitored **Zoho** mailbox or alias (for example
create `ops@dovepeakdigital.com` in Zoho Mail Admin → Groups or Aliases). It receives:

- alerts every 15 minutes at most (each kind at most once every 6 hours): bounce rate above
  5%, complaint rate above 0.1%, more than 50 delays an hour, emails with no delivery result
  after 2 hours, the IP on Spamhaus, SpamCop or Barracuda, or `mta1` not resolving;
- mail sent to `postmaster@`, `abuse@`, `dmarc@`, `tls-reports@` (and any other address) at
  `tredmail.dovepeakdigital.com`, forwarded as an attachment, at most 200 a day.

In Zoho, add `no-reply@tredmail.dovepeakdigital.com` to the allowed senders so early alerts are
not filtered while the IP is new.
