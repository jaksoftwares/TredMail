/**
 * One-time payment gateway setup: registers TredMail's notification URLs with each
 * configured gateway (for M-Pesa: the Paybill confirmation and validation URLs), and prints
 * the callback URLs in use.
 *
 *   npm run payments:setup
 *   node dist/cli/payments-setup.js     (production image)
 *
 * Safaricom registers C2B URLs once per short code in production; to change them later,
 * delete the old ones in the M-Pesa organisation portal first.
 */
import { allGateways, callbackUrl } from "@tredmail/core/billing/gateways/registry";

async function main() {
  const gateways = allGateways().filter((g) => !g.staffOnly);
  if (gateways.length === 0) {
    console.log("No payment gateway is configured. Set the MPESA_* variables (see docs/BILLING_AND_PAYMENTS.md).");
    return;
  }
  for (const gateway of gateways) {
    console.log(`${gateway.name} (${gateway.id})`);
    if (gateway.handleCallback) {
      console.log(`  callbacks: ${callbackUrl(gateway, "<kind>").replace(/[^/]+$/, "<secret token>")}`);
    }
    if (gateway.setup) {
      try {
        for (const line of await gateway.setup()) console.log(`  ${line}`);
      } catch (err) {
        console.error(`  setup failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
