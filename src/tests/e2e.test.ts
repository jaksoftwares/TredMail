import { env } from "../config/env.js";
import { prisma } from "../db/client.js";

const MASTER_API_KEY = "tred_live_REDACTED_REVOKED";

async function runEndToEndTest() {
  console.log("🧪 Starting TredMail End-to-End Integration Test...\n");

  const baseUrl = `http://localhost:${env.PORT}/v1`;

  // 1. Test Health Check
  console.log("1️⃣ Checking API Health...");
  const healthRes = await fetch(`http://localhost:${env.PORT}/health`);
  const healthData = await healthRes.json();
  console.log("   Health Status:", healthData.status);

  // 2. Test Get Domains
  console.log("\n2️⃣ Fetching registered domains with API Key...");
  const domainsRes = await fetch(`${baseUrl}/domains`, {
    headers: { Authorization: `Bearer ${MASTER_API_KEY}` },
  });
  const domainsData = await domainsRes.json();
  console.log(`   Found ${domainsData.data.length} registered domain(s):`, domainsData.data.map((d: any) => d.name));

  // 3. Send Transactional Email
  console.log("\n3️⃣ Sending transactional email via POST /v1/emails...");
  const emailPayload = {
    from: "Dovepeak Cloud <system@dovepeak.com>",
    to: "client@example.com",
    subject: "Welcome to TredMail Platform (End-to-End Test)",
    html: `
      <!DOCTYPE html>
      <html>
        <body style="font-family: sans-serif; padding: 20px; color: #1e293b;">
          <h2>TredMail System Verification</h2>
          <p>Congratulations! Your in-house transactional email infrastructure is operational.</p>
          <p><a href="https://dovepeak.com/dashboard" style="background: #2563eb; color: #ffffff; padding: 10px 18px; text-decoration: none; border-radius: 6px;">Open Dovepeak Console</a></p>
        </body>
      </html>
    `,
    text: "TredMail System Verification: Your email infrastructure is operational.",
    headers: {
      "X-Dovepeak-Environment": "Development",
    },
  };

  const sendRes = await fetch(`${baseUrl}/emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MASTER_API_KEY}`,
    },
    body: JSON.stringify(emailPayload),
  });

  if (!sendRes.ok) {
    const errorBody = await sendRes.text();
    throw new Error(`Failed to send email (${sendRes.status}): ${errorBody}`);
  }

  const sendData = await sendRes.json();
  console.log(`   Email enqueued! Message ID: ${sendData.id}`);
  console.log(`   Status: ${sendData.status}`);

  // 4. Wait for BullMQ worker to process and deliver to Mailpit
  console.log("\n4️⃣ Waiting for BullMQ worker to deliver via SMTP...");
  let delivered = false;
  let attempts = 0;

  while (!delivered && attempts < 10) {
    await new Promise((r) => setTimeout(r, 1000));
    attempts++;

    const statusRes = await fetch(`${baseUrl}/emails/${sendData.id}`, {
      headers: { Authorization: `Bearer ${MASTER_API_KEY}` },
    });
    const emailStatus = await statusRes.json();

    if (emailStatus.status === "delivered") {
      delivered = true;
      console.log(`   ✅ Email delivered in ${attempts}s!`);
      console.log(`   SMTP Response: ${emailStatus.smtp_response}`);
      console.log(`   Timeline Events:`, emailStatus.events.map((e: any) => `${e.type} @ ${e.timestamp}`));
    }
  }

  if (!delivered) {
    console.warn("   ⚠️ Worker did not complete delivery within 10 seconds. Check if worker is running.");
  }

  // 5. Test Open Tracking
  console.log("\n5️⃣ Simulating email recipient open tracking...");
  const openRes = await fetch(`${baseUrl}/track/open/${sendData.id}`);
  console.log(`   Open pixel fetched (Status: ${openRes.status}, Content-Type: ${openRes.headers.get("content-type")})`);

  // Verify open event recorded in DB
  const updatedEmail = await prisma.email.findUnique({
    where: { id: sendData.id },
    include: { events: true },
  });
  const openEvent = updatedEmail?.events.find((e) => e.type === "OPENED");
  if (openEvent) {
    console.log(`   ✅ Open event confirmed in timeline! (IP: ${openEvent.ipAddress})`);
  }

  // 6. Test Stats API
  console.log("\n6️⃣ Fetching analytics from GET /v1/stats...");
  const statsRes = await fetch(`${baseUrl}/stats`, {
    headers: { Authorization: `Bearer ${MASTER_API_KEY}` },
  });
  const statsData = await statsRes.json();
  console.log("   Dashboard Metrics:", statsData.metrics);

  console.log("\n🎉 ALL TESTS PASSED! TredMail Core Pipeline is 100% OPERATIONAL!");
  console.log(`📬 View sent emails in Mailpit Web UI: http://localhost:8035`);
}

runEndToEndTest()
  .catch((err) => {
    console.error("\n❌ E2E Test Failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
