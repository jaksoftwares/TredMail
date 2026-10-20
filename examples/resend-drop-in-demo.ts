/**
 * Sending with the Resend-compatible payload.
 *
 *   TREDMAIL_API_KEY=tred_live_... npx tsx examples/resend-drop-in-demo.ts
 *
 * With the official `resend` package, point it at TredMail instead of writing fetch calls:
 *   const resend = new Resend(process.env.TREDMAIL_API_KEY);  // with RESEND_BASE_URL=http://localhost:3000/v1
 */
async function sendViaTredMail() {
  const apiKey = process.env.TREDMAIL_API_KEY;
  const apiUrl = process.env.TREDMAIL_API_URL ?? "http://localhost:3000/v1";
  if (!apiKey) {
    throw new Error("Set TREDMAIL_API_KEY. Never hard-code API keys in source files.");
  }

  const response = await fetch(`${apiUrl}/emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: "Dovepeak Team <notifications@dovepeak.com>",
      to: ["developer@example.com"],
      subject: "Resend-compatible payload confirmed",
      html: `
        <div style="font-family: 'Open Sans', Arial, sans-serif; padding: 24px; background: #f8f8ff; color: #000027;">
          <h2>TredMail integration active</h2>
          <p>This message used the same payload you would send to Resend.</p>
          <a href="https://dovepeak.com" style="background: #ff6300; color: #000027; padding: 10px 18px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 700;">
            Open Dovepeak
          </a>
        </div>
      `,
      headers: { "X-Source": "Dovepeak-Billing-Service" },
      tags: [{ name: "category", value: "account_alert" }],
    }),
  });

  const data = await response.json();
  console.log(response.ok ? "Accepted:" : "Rejected:", data);
}

sendViaTredMail().catch((err) => {
  console.error(err);
  process.exit(1);
});
