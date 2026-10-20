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
> 2. Allow inbound TCP port 25, so it can receive bounce reports for our bounce domain.
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

### Before adding MX records: check Mail Settings

MX records sit under **Advanced DNS → Mail Settings**, which must be set to **Custom MX**.
That setting applies to the whole domain. If `dovepeakdigital.com` itself currently receives
mail through **Email Forwarding** or **Private Email**, switching to Custom MX removes those
root MX records, so write them down first and add them back as Custom MX rows with host `@`.
If the root already uses Custom MX (Google Workspace, Zoho, and so on), simply add the new rows.

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

Record 8 is what the console's Domains page expects for `tredmail.dovepeakdigital.com`. When
a second sending IP is added later, only record 7 changes.

**Record 13 (DKIM)** is generated by TredMail, so it cannot be listed in advance. After the
first deploy and `npm run db:seed`, sign in to the console as the owner, switch to the
**TredMail Platform** workspace, open **Domains → tredmail.dovepeakdigital.com**, and copy the
DKIM value (it starts with `v=DKIM1; k=rsa; p=`). Namecheap accepts the long value in one
field. Then press **Verify** on the same page.

**Record 11 (DMARC):** keep `p=none` for the first 2 to 4 weeks while reports confirm every
message passes SPF and DKIM, then change it to `p=quarantine`. The Domains page shows
`p=quarantine` as the end goal; verification accepts either.

### Records to add later (Phase 2 will say when)

| Type | Host | Value | Notes |
| --- | --- | --- | --- |
| A | `mta-sts.tredmail` | `<SERVER_IP>` | Serves the MTA-STS policy over HTTPS |
| TXT | `_mta-sts.tredmail` | `v=STSv1; id=<given then>` | Publish only once the policy is being served |

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

A domain may have only **one** SPF record. If `@` already has `v=spf1 ...` (for example from
Google Workspace or Namecheap Private Email), add the include to it rather than creating a
second record: `v=spf1 include:_spf.google.com include:_spf.tredmail.dovepeakdigital.com ~all`.

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
providers treat it as new. TredMail ramps volume up over 2 to 4 weeks and sends anything above
the day's limit through the fallback provider, so no mail is held back while the IP earns its
reputation.
