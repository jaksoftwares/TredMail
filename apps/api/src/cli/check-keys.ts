/**
 * Checks that every encrypted secret in the database decrypts with this installation's
 * TREDMAIL_MASTER_ENCRYPTION_KEY. Run after a restore (scripts/restore.sh does) or a key
 * change: a domain whose DKIM key cannot be decrypted cannot send.
 *
 *   node apps/api/dist/cli/check-keys.js     (exit code 1 when any secret fails)
 */
import { prisma } from "@tredmail/db";
import { decryptSecret } from "@tredmail/core/security/crypto";

async function main() {
  const domains = await prisma.domain.findMany({ select: { name: true, organizationId: true, dkimPrivateKey: true } });
  const failed: string[] = [];
  for (const domain of domains) {
    try {
      decryptSecret(domain.dkimPrivateKey);
    } catch {
      failed.push(`DKIM key of ${domain.name} (workspace ${domain.organizationId})`);
    }
  }

  console.log(`check-keys: ${domains.length - failed.length} of ${domains.length} DKIM keys decrypt`);
  if (failed.length > 0) {
    console.error(`check-keys: ${failed.length} secret(s) do not decrypt with this TREDMAIL_MASTER_ENCRYPTION_KEY:`);
    for (const item of failed) console.error(`  - ${item}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("check-keys failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
