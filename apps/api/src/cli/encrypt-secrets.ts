/**
 * Encrypts webhook signing secrets still stored in plain text (rows created before secrets were
 * encrypted at rest). Safe to run any number of times; deploy-hostinger.sh runs it after the
 * migrations on every deploy.
 *
 *   node apps/api/dist/cli/encrypt-secrets.js
 */
import { prisma } from "@tredmail/db";
import { isSealedWebhookSecret, sealWebhookSecret } from "@tredmail/core/webhooks/dispatcher";

async function main() {
  const webhooks = await prisma.webhook.findMany({ where: { secret: { startsWith: "whsec_" } }, select: { id: true, secret: true } });
  let converted = 0;
  for (const webhook of webhooks) {
    if (isSealedWebhookSecret(webhook.secret)) continue;
    // Only rewrite the row if nobody rotated the secret meanwhile
    const result = await prisma.webhook.updateMany({ where: { id: webhook.id, secret: webhook.secret }, data: { secret: sealWebhookSecret(webhook.secret) } });
    converted += result.count;
  }
  console.log(`encrypt-secrets: ${converted} webhook secret(s) encrypted`);
}

main()
  .catch((err) => {
    console.error("encrypt-secrets failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // The webhook module opens a Redis connection on import; nothing here needs it
    process.exit();
  });
