/**
 * Incident response: revoke an API key given its plaintext value, e.g. one leaked in a repository.
 *
 *   npm run keys:revoke -- tred_live_...            (development)
 *   node dist/cli/revoke-api-key.js tred_live_...   (production image)
 *
 * Prints whether the key existed in this database. Safe to run more than once.
 */
import { prisma } from "../db/client.js";
import { hashApiKey } from "../security/api-keys.js";

async function main() {
  const token = process.argv[2]?.trim();
  if (!token) {
    console.error("Usage: revoke-api-key <plaintext key>");
    process.exit(1);
  }

  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(token) },
    include: { organization: { select: { slug: true } } },
  });

  if (!key) {
    console.log("No key with that value exists in this database. Nothing to revoke.");
    return;
  }
  if (key.revokedAt) {
    console.log(`Key '${key.name}' (${key.keyPrefix}) was already revoked at ${key.revokedAt.toISOString()}.`);
    return;
  }

  await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
  console.log(`Revoked key '${key.name}' (${key.keyPrefix}) for organization '${key.organization.slug}'.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
