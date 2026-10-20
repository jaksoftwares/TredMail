# TredMail API Specification & Developer Guide

TredMail's REST API is designed for developer ergonomics and follows the modern standards established by **Resend** and **Postmark**. In fact, TredMail's API endpoints are **drop-in compatible** with popular Resend SDKs simply by overriding the base URL.

---

## 1. Authentication & Base URL

All requests must be made over **HTTPS**. Authenticate by providing your API key in the `Authorization` header with the `Bearer` scheme.

```http
Authorization: Bearer tred_live_...
```

* **Production Base URL**: `https://api.tredmail.dovepeakdigital.com/v1`
* **Development / Self-Hosted Local URL**: `http://localhost:3000/v1`

---

## 2. Emails Endpoints

### 2.1 Send a Single Email
Send a transactional or marketing email to one or multiple recipients.

`POST /v1/emails`

#### Request Headers
```http
Content-Type: application/json
Authorization: Bearer tred_live_...
```

#### Request Body
```json
{
  "from": "Dovepeak Team <onboarding@dovepeakdigital.com>",
  "to": ["client@example.com"],
  "cc": ["manager@dovepeakdigital.com"],
  "bcc": ["archive@dovepeakdigital.com"],
  "reply_to": "support@dovepeakdigital.com",
  "subject": "Welcome to Dovepeak Cloud Platform",
  "html": "<!DOCTYPE html><html><body><h1>Hello, World!</h1><p>Welcome to our platform.</p></body></html>",
  "text": "Hello, World! Welcome to our platform.",
  "headers": {
    "X-Entity-Ref-ID": "inv_984321"
  },
  "tags": [
    { "name": "category", "value": "transactional" },
    { "name": "app", "value": "dovepeak-auth" }
  ],
  "attachments": [
    {
      "filename": "invoice_984321.pdf",
      "content": "JVBERi0xLjQKJcOkw7zDtsOfCDCk...",
      "content_type": "application/pdf"
    }
  ]
}
```

#### Response (`200 OK`)
```json
{
  "id": "msg_90e76b25-41a4-4df2-bc67-0c67f4077641",
  "from": "Dovepeak Team <onboarding@dovepeakdigital.com>",
  "to": ["client@example.com"],
  "status": "queued",
  "created_at": "2026-10-17T12:00:00.000Z"
}
```

#### Error Response (`400 Bad Request - Domain Not Verified`)
```json
{
  "statusCode": 400,
  "name": "validation_error",
  "message": "The domain 'dovepeakdigital.com' has not completed DKIM/SPF verification. Please verify DNS records in the TredMail console.",
  "code": "DOMAIN_NOT_VERIFIED"
}
```

#### Error Response (`422 Unprocessable Entity - Suppressed Recipient`)
```json
{
  "statusCode": 422,
  "name": "recipient_suppressed",
  "message": "Email 'client@example.com' is on the suppression list due to a previous Hard Bounce (550 User Unknown).",
  "code": "RECIPIENT_SUPPRESSED"
}
```

---

### 2.2 Send Batch Emails
Send up to 100 individual emails in a single HTTP request.

`POST /v1/batch`

#### Request Body
```json
[
  {
    "from": "alerts@dovepeakdigital.com",
    "to": "user1@example.com",
    "subject": "Security notification",
    "html": "<p>A new login was detected.</p>"
  },
  {
    "from": "alerts@dovepeakdigital.com",
    "to": "user2@example.com",
    "subject": "Security notification",
    "html": "<p>A new login was detected.</p>"
  }
]
```

#### Response (`200 OK`)
```json
{
  "data": [
    { "id": "msg_01", "status": "queued" },
    { "id": "msg_02", "status": "queued" }
  ]
}
```

---

### 2.3 Retrieve Email Status & Delivery Timeline
Inspect the live status, delivery timestamp, and tracking events for a specific email.

`GET /v1/emails/{id}`

#### Response (`200 OK`)
```json
{
  "id": "msg_90e76b25-41a4-4df2-bc67-0c67f4077641",
  "from": "onboarding@dovepeakdigital.com",
  "to": ["client@example.com"],
  "subject": "Welcome to Dovepeak Cloud Platform",
  "status": "delivered",
  "created_at": "2026-10-17T12:00:00.000Z",
  "delivered_at": "2026-10-17T12:00:02.140Z",
  "last_event": "opened",
  "events": [
    {
      "type": "queued",
      "timestamp": "2026-10-17T12:00:00.000Z"
    },
    {
      "type": "delivered",
      "timestamp": "2026-10-17T12:00:02.140Z",
      "smtp_response": "250 2.0.0 OK 1729166402 d29si12345678wme.10 - gsmtp"
    },
    {
      "type": "opened",
      "timestamp": "2026-10-17T12:04:15.320Z",
      "ip_address": "203.0.113.42",
      "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)..."
    }
  ]
}
```

---

## 3. Domains & DNS Verification Endpoints

### 3.1 Register a Domain
Registers a new sending domain in TredMail and generates custom DKIM, SPF, and DMARC credentials.

`POST /v1/domains`

#### Request Body
```json
{
  "name": "dovepeakdigital.com",
  "region": "eu-central"
}
```

#### Response (`201 Created`)
```json
{
  "id": "dom_d41d8cd98f00b204e9800998ecf8427e",
  "name": "dovepeakdigital.com",
  "status": "pending",
  "records": [
    {
      "record": "DKIM",
      "name": "tredmail._domainkey.dovepeakdigital.com",
      "type": "TXT",
      "ttl": "Auto",
      "status": "pending",
      "value": "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
    },
    {
      "record": "SPF",
      "name": "dovepeakdigital.com",
      "type": "TXT",
      "ttl": "Auto",
      "status": "pending",
      "value": "v=spf1 include:_spf.tredmail.dovepeakdigital.com ~all"
    },
    {
      "record": "DMARC",
      "name": "_dmarc.dovepeakdigital.com",
      "type": "TXT",
      "ttl": "Auto",
      "status": "pending",
      "value": "v=DMARC1; p=quarantine; rua=mailto:dmarc@tredmail.dovepeakdigital.com;"
    },
    {
      "record": "Return-Path",
      "name": "bounces.dovepeakdigital.com",
      "type": "CNAME",
      "ttl": "Auto",
      "status": "pending",
      "value": "bounces.tredmail.dovepeakdigital.com"
    }
  ]
}
```

### 3.2 Trigger Instant Domain Verification
Forces TredMail to perform an active DNS lookup on the domain's TXT and CNAME records.

`POST /v1/domains/{id}/verify`

#### Response (`200 OK`)
```json
{
  "id": "dom_d41d8cd98f00b204e9800998ecf8427e",
  "name": "dovepeakdigital.com",
  "status": "verified",
  "verified_at": "2026-10-17T12:05:00.000Z"
}
```

---

## 4. Webhooks & Event Notifications

TredMail can dispatch real-time JSON webhooks to your applications when email events occur.

### Supported Event Types:
- `email.sent`
- `email.delivered`
- `email.opened`
- `email.clicked`
- `email.bounced` (Includes hard/soft bounce categorization and SMTP diagnostic string)
- `email.complained` (Spam report)

#### Example Webhook Payload (`email.delivered`)
```json
{
  "event": "email.delivered",
  "created_at": "2026-10-17T12:00:02.140Z",
  "data": {
    "email_id": "msg_90e76b25-41a4-4df2-bc67-0c67f4077641",
    "from": "onboarding@dovepeakdigital.com",
    "to": ["client@example.com"],
    "subject": "Welcome to Dovepeak Cloud Platform",
    "smtp_response": "250 2.0.0 OK 1729166402 d29si12345678wme.10 - gsmtp"
  }
}
```

---

## 5. Integration Code Samples

### 5.1 Node.js / TypeScript (Native Fetch)
```typescript
async function sendWelcomeEmail() {
  const response = await fetch("https://api.tredmail.dovepeakdigital.com/v1/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.TREDMAIL_API_KEY}`,
    },
    body: JSON.stringify({
      from: "Dovepeak <notifications@dovepeakdigital.com>",
      to: ["user@example.com"],
      subject: "Your Dovepeak Account is Active",
      html: "<h1>Welcome aboard</h1><p>Your subscription is active.</p>",
    }),
  });

  const data = await response.json();
  console.log("Email enqueued with ID:", data.id);
}
```

### 5.2 Drop-in Resend SDK Compatibility
If your existing codebase already uses the official `resend` npm library, you do **not** need to rewrite your code! Simply point the `baseUrl` to TredMail:

```typescript
import { Resend } from "resend";

// Initialize Resend with TredMail host and key
const resend = new Resend(process.env.TREDMAIL_API_KEY);

// Send email using existing Resend SDK code
const { data, error } = await resend.emails.send({
  from: "notifications@dovepeakdigital.com",
  to: "client@example.com",
  subject: "Automated Monthly Invoice",
  html: "<strong>Please find your invoice attached.</strong>",
  // Override baseUrl to Dovepeak's self-hosted TredMail server
  headers: { "X-TredMail-Tenant": "dovepeak-prod" }
});
```

### 5.3 Python
```python
import os
import requests

def send_email():
    url = "https://api.tredmail.dovepeakdigital.com/v1/emails"
    headers = {
        "Authorization": f"Bearer {os.environ.get('TREDMAIL_API_KEY')}",
        "Content-Type": "application/json"
    }
    payload = {
        "from": "Dovepeak Technology <support@dovepeakdigital.com>",
        "to": ["user@example.com"],
        "subject": "Password Reset Request",
        "html": "<p>Click <a href='https://dovepeakdigital.com/reset'>here</a> to reset your password.</p>"
    }

    res = requests.post(url, json=payload, headers=headers)
    print(res.status_code, res.json())

send_email()
```

### 5.4 cURL
```bash
curl -X POST "https://api.tredmail.dovepeakdigital.com/v1/emails" \
  -H "Authorization: Bearer $TREDMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Dovepeak Team <hi@dovepeakdigital.com>",
    "to": ["partner@company.com"],
    "subject": "System Verification Successful",
    "html": "<h3>Status: Operational</h3>"
  }'
```
