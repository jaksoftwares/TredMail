/**
 * TredMail Drop-In Resend Compatibility Demo
 * 
 * If your existing codebase uses the official `@resend/node` or `resend` npm package,
 * you can switch to Dovepeak's self-hosted TredMail with ZERO code refactoring!
 * 
 * Simply point the API key and Base URL to your TredMail server:
 */

// Step 1: Initialize Resend pointing to TredMail
// When using the Resend npm package:
// const { Resend } = require('resend');
// const resend = new Resend(process.env.TREDMAIL_API_KEY, {
//   baseUrl: 'http://localhost:3000/v1' // or 'https://api.tredmail.dovepeak.com/v1'
// });

// Or using standard fetch (identical API signature):
async function sendViaTredMail() {
  const TREDMAIL_API_KEY = "tred_live_REDACTED_REVOKED";
  const TREDMAIL_API_URL = "http://localhost:3000/v1/emails";

  console.log("📨 Sending email using Resend-compatible payload...");

  const response = await fetch(TREDMAIL_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TREDMAIL_API_KEY}`,
    },
    body: JSON.stringify({
      from: "Dovepeak Team <notifications@dovepeak.com>",
      to: ["developer@example.com"],
      subject: "Drop-in Resend Compatibility Confirmed",
      html: `
        <div style="font-family: sans-serif; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 8px;">
          <h2 style="color: #6366f1;">TredMail Integration Active</h2>
          <p>This message was sent using the exact same schema you use for Resend or Postmark.</p>
          <p>Zero monthly subscription fees. Unlimited internal throughput.</p>
          <a href="https://dovepeak.com" style="background: #6366f1; color: white; padding: 10px 18px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Open Dovepeak Portal
          </a>
        </div>
      `,
      headers: {
        "X-Environment": "Production",
        "X-Source": "Dovepeak-Billing-Service",
      },
      tags: [
        { name: "category", "value": "account_alert" }
      ]
    }),
  });

  const data = await response.json();
  console.log("✅ Response from TredMail:", data);
  console.log(`📬 Message ID: ${data.id}`);
  console.log(`🔍 Inspect delivery at: http://localhost:3001/`);
}

sendViaTredMail();
