# TredMail Implementation Roadmap & Execution Plan

This guide outlines the step-by-step phases required to take **TredMail** from architecture to a live, production-ready, self-hosted email platform for Dovepeak Technology.

---

## Phase 1: Infrastructure & MTA Setup (Days 1–3)

### Goal
Establish a clean, dedicated server capable of outbound SMTP on Port 25 with Forward-Confirmed Reverse DNS (FCrDNS).

### Execution Steps
1. **Provision VPS**:
   - Recommended: Hetzner Cloud (CPX31 or Dedicated vCPU) or OVHcloud VPS.
   - Operating System: Ubuntu 24.04 LTS.
   - Attach a Dedicated Public IPv4 address.
2. **Verify IP Cleanliness**:
   - Test IP on [MXToolbox Blacklist Check](https://mxtoolbox.com/blacklists.aspx) and [Spamhaus Zen](https://check.spamhaus.org/).
   - Ensure the IP is not on any active blacklist.
3. **Configure Reverse DNS (PTR)**:
   - In cloud console (Hetzner/OVH), configure the IPv4 Reverse DNS to point to:
     `mail.tredmail.dovepeak.com`.
   - In your primary DNS provider (e.g. Cloudflare), create an `A` record:
     `mail.tredmail.dovepeak.com -> <YOUR_SERVER_IP>`.
   - Verify using `dig -x <YOUR_SERVER_IP> +short`.
4. **Unblock Port 25**:
   - If using Hetzner or Linode, submit a brief support ticket requesting Port 25 outbound unblock for business transactional emails.
   - Test outbound port connectivity from the server:
     ```bash
     telnet gmail-smtp-in.l.google.com 25
     # Expected: 220 mx.google.com ESMTP ...
     ```
5. **Deploy MTA Engine (Postal or KumoMTA)**:
   - Deploy via Docker Compose.
   - Configure local SMTP submission listener on `127.0.0.1:2525` with TLS enabled.

---

## Phase 2: Database & Core Platform API (Days 4–7)

### Goal
Build the REST API control plane, database models, and API key authentication system.

### Execution Steps
1. **Initialize Project Repository**:
   - TypeScript Monorepo or clean Fastify / Next.js architecture.
   - Stack: Fastify (High-speed REST API) + Next.js (Management Console).
2. **Setup PostgreSQL & Prisma**:
   - Apply the [DATABASE_SCHEMA.prisma](file:///c:/Users/josep/TredMail/docs/DATABASE_SCHEMA.prisma).
   - Generate Prisma Client: `npx prisma db push`.
3. **API Key Authentication Middleware**:
   - Implement key generation with prefix (`tred_live_...`).
   - Hash keys with SHA-256 before database insertion.
   - Implement bearer token validator middleware for `/v1/*` routes.
4. **Idempotency & Rate Limiting**:
   - Implement Redis-backed token bucket rate limiter per API key.
   - Implement optional `Idempotency-Key` header handling to prevent duplicate email dispatches.

---

## Phase 3: Domain Verification Engine (Days 8–11)

### Goal
Enable automated generation and verification of DKIM, SPF, DMARC, and Return-Path DNS records.

### Execution Steps
1. **DKIM Keypair Generator Service**:
   ```typescript
   import { generateKeyPairSync } from "crypto";

   export function generateDkimKeys() {
     const { publicKey, privateKey } = generateKeyPairSync("rsa", {
       modulusLength: 2048,
       publicKeyEncoding: { type: "spki", format: "pem" },
       privateKeyEncoding: { type: "pkcs8", format: "pem" },
     });
     return { publicKey, privateKey };
   }
   ```
2. **Automated DNS Verifier**:
   - Use Node.js `dns.promises`:
     - Query `resolveTxt(domain)` for SPF.
     - Query `resolveTxt('tredmail._domainkey.' + domain)` for DKIM public key.
     - Query `resolveTxt('_dmarc.' + domain)` for DMARC policy.
     - Query `resolveCname('bounces.' + domain)` for Return-Path.
   - Return clear `pending` vs `verified` status per record.
3. **Domain Verification UI**:
   - Clean, copyable dashboard cards with 1-click clipboard buttons (matching Resend's UX).

---

## Phase 4: Queueing, MIME Compilation & DKIM Signing (Days 12–16)

### Goal
Accept API requests, buffer in Redis, compile valid RFC 5322 MIME messages with DKIM cryptographic signatures, and submit to the MTA.

### Execution Steps
1. **BullMQ Worker Pipeline**:
   - Route `POST /v1/emails` directly into Redis queue.
   - Immediate HTTP 200 response with generated `msg_...` ID (latency < 15ms).
2. **Suppression Guard**:
   - Pre-check recipient against `suppressions` table before queueing or during worker processing.
3. **MIME Compiler (Nodemailer / Mailcomposer)**:
   - Construct RFC-compliant multipart email (HTML + Plaintext + Attachments).
   - Inject required headers:
     - `Message-ID: <unique_id@mail.tredmail.dovepeak.com>`
     - `Date`
     - `List-Unsubscribe` & `List-Unsubscribe-Post` (One-Click)
4. **DKIM Cryptographic Signer**:
   - Decrypt the domain's private key.
   - Sign headers and body using `nodemailer/lib/dkim` or native crypto.
5. **SMTP Dispatch to MTA**:
   - Deliver signed MIME stream to the local MTA engine (`127.0.0.1:2525`).

---

## Phase 5: Tracking & Webhooks System (Days 17–20)

### Goal
Provide real-time visibility into email opens, link clicks, deliveries, and bounces.

### Execution Steps
1. **Tracking Server**:
   - Mount lightweight HTTP endpoints on `track.tredmail.dovepeak.com`:
     - `GET /open/:emailId`: Returns 1x1 transparent GIF (`Content-Type: image/gif`), records `OPENED` event with timestamp, IP, and user-agent.
     - `GET /click/:emailId?url=...`: Logs `CLICKED` event and issues HTTP 302 redirect.
2. **Inbound Bounce & Feedback Loop Handler**:
   - Configure MTA to post DSN bounce events to an internal webhook endpoint: `POST /internal/bounces`.
   - Parse SMTP error codes:
     - If `5xx` (Hard bounce) -> Add to `suppressions` table + mark email as `BOUNCED`.
     - If `4xx` (Soft bounce) -> Allow queue retry.
3. **Outbound Webhook Dispatcher**:
   - Fan-out events to user-configured webhook URLs.
   - Sign payloads using HMAC-SHA256 signature in `X-TredMail-Signature` header.
   - Implement exponential backoff for failed webhook endpoints (up to 5 attempts).

---

## Phase 6: Modern Web Console UI (Days 21–25)

### Goal
Deliver a sleek, state-of-the-art developer dashboard inspired by Resend and modern SaaS tools.

### Key Console Views
1. **Overview / Analytics Dashboard**:
   - Delivery rate, bounce rate, open rate, click-through rate.
   - 24-hour volume graphs.
2. **Live Email Inspector**:
   - Real-time stream of sent emails.
   - Click to inspect raw headers, rendered HTML preview, and chronological event audit timeline (`queued` -> `delivered` -> `opened`).
3. **Domains Management**:
   - Domain list, DNS verification status badges, detailed DNS setup instructions with 1-click copy.
4. **API Keys**:
   - Create, revoke, and manage API keys with granular scopes (`Full Access` vs `Sending Only`).
5. **Suppression List & Webhooks**:
   - Searchable table of suppressed addresses with "Remove from suppression" capability.
   - Webhook test ping generator.

---

## Phase 7: IP Warmup & Commercialization Readiness (Days 26+)

### Goal
Scale sending volume safely and prepare multi-tenancy for commercial billing if Dovepeak chooses to commercialize.

### Execution Steps
1. **Activate Automated IP Warmup**:
   - Implement daily destination caps (e.g., maximum 100 emails/day to Gmail on Day 1, ramping up over 30 days).
2. **Monitor Reputation**:
   - Link domain with Google Postmaster Tools and Microsoft SNDS.
3. **Commercialization Ready**:
   - The database schema is already built multi-tenant with `Organization` boundaries.
   - Simply connect Stripe Checkout / Billing to enforce `monthlyQuota` and charge external clients.
