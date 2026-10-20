/**
 * Bootstraps a TredMail installation. Safe to run more than once.
 *
 * Creates:
 *  - the platform workspace, which owns TredMail's own sending domain (PRIMARY_DOMAIN) used
 *    for account emails (no-reply@) and the sandbox sender (onboarding@)
 *  - the Dovepeak workspace on the unlimited internal plan, with dovepeakdigital.com
 *  - an owner login for both (SEED_ADMIN_EMAIL), with a generated password shown once
 *  - a full-access API key for the Dovepeak workspace, shown once
 *
 * In development the two domains are marked verified so mail flows to Mailpit. Anywhere else
 * they stay pending and the DNS records to publish are printed.
 */
import crypto from "crypto";
import { hashPassword } from "better-auth/crypto";
import { prisma, type Organization } from "@tredmail/db";
import { env, PLATFORM_ORG_SLUG } from "@tredmail/core/config/env";
import { generateApiKey } from "@tredmail/core/security/api-keys";
import { encryptSecret } from "@tredmail/core/security/crypto";
import { generateDkimKeypair } from "@tredmail/core/security/dkim-keys";
import { generateExpectedDnsRecords } from "@tredmail/core/dns/generator";

const markVerified = env.NODE_ENV === "development";
const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@dovepeakdigital.com").toLowerCase();

async function ensureWorkspace(slug: string, name: string): Promise<Organization> {
  return prisma.organization.upsert({
    where: { slug },
    update: {},
    create: { slug, name, isCommercial: false, planTier: "unlimited_internal", monthlyQuota: 0 },
  });
}

async function ensureDomain(organizationId: string, name: string) {
  const existing = await prisma.domain.findFirst({ where: { organizationId, name } });
  if (existing) return existing;

  const dkim = generateDkimKeypair();
  const domain = await prisma.domain.create({
    data: {
      organizationId,
      name,
      status: markVerified ? "VERIFIED" : "PENDING",
      dkimSelector: env.DEFAULT_DKIM_SELECTOR,
      dkimPublicKey: dkim.dnsTxtValue,
      dkimPrivateKey: encryptSecret(dkim.privateKeyPem),
      spfVerified: markVerified,
      dkimVerified: markVerified,
      dmarcVerified: markVerified,
      returnPathVerified: markVerified,
      verifiedAt: markVerified ? new Date() : null,
    },
  });

  if (markVerified) {
    console.log(`  domain ${name}: marked verified (development only)`);
  } else {
    console.log(`  domain ${name}: pending. Publish these records, then verify it in the console:`);
    for (const record of generateExpectedDnsRecords(domain.name, domain.dkimSelector, domain.dkimPublicKey)) {
      console.log(`    ${record.type.padEnd(5)} ${record.name}\n          ${record.expectedValue}`);
    }
  }
  return domain;
}

async function ensureAdmin(workspaceIds: string[]) {
  let user = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!user) {
    user = await prisma.user.create({ data: { email: adminEmail, name: "Dovepeak Administrator", emailVerified: true } });
  } else if (!user.emailVerified) {
    user = await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  }

  let password: string | null = null;
  const credential = await prisma.account.findFirst({ where: { userId: user.id, providerId: "credential" } });
  if (!credential) {
    password = process.env.SEED_ADMIN_PASSWORD ?? crypto.randomBytes(12).toString("base64url");
    await prisma.account.create({
      data: { userId: user.id, providerId: "credential", accountId: user.id, password: await hashPassword(password) },
    });
  }

  for (const organizationId of workspaceIds) {
    await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      update: { role: "OWNER" },
      create: { organizationId, userId: user.id, role: "OWNER" },
    });
  }

  console.log(`  owner login: ${adminEmail}`);
  if (password && !process.env.SEED_ADMIN_PASSWORD) {
    console.log(`  password (shown once, change it after signing in): ${password}`);
  }
}

async function main() {
  console.log("Seeding TredMail...");

  const platform = await ensureWorkspace(PLATFORM_ORG_SLUG, "TredMail Platform");
  console.log(`- platform workspace: ${platform.slug}`);
  await ensureDomain(platform.id, env.PRIMARY_DOMAIN.toLowerCase());

  const dovepeak = await ensureWorkspace("dovepeak", "Dovepeak Technologies");
  console.log(`- workspace: ${dovepeak.slug}`);
  await ensureDomain(dovepeak.id, "dovepeakdigital.com");

  console.log("- owner");
  await ensureAdmin([platform.id, dovepeak.id]);

  const activeKey = await prisma.apiKey.findFirst({
    where: { organizationId: dovepeak.id, name: "Dovepeak Master Key", revokedAt: null },
  });
  if (!activeKey) {
    const key = generateApiKey(true);
    await prisma.apiKey.create({
      data: {
        organizationId: dovepeak.id,
        name: "Dovepeak Master Key",
        keyPrefix: key.keyPrefix,
        keyHash: key.keyHash,
        scopes: ["full_access"],
      },
    });
    console.log(`- API key for '${dovepeak.slug}' (shown once; store it in a secret manager):\n  ${key.plaintextKey}`);
  }

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
