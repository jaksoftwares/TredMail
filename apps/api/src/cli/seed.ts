import { prisma } from "@tredmail/db";
import { generateDkimKeypair } from "@tredmail/core/security/dkim-keys";
import { encryptSecret } from "@tredmail/core/security/crypto";
import { generateApiKey } from "@tredmail/core/security/api-keys";
import { env } from "@tredmail/core/config/env";

// Mailpit never sees real DNS, so local development marks the seed domain verified.
// Anywhere else the domain must pass real DNS verification before it can send.
const markDomainVerified = env.NODE_ENV === "development";

async function main() {
  console.log("🌱 Seeding TredMail database...");

  // 1. Create Dovepeak Organization
  const org = await prisma.organization.upsert({
    where: { slug: "dovepeak" },
    update: {},
    create: {
      name: "Dovepeak Technology",
      slug: "dovepeak",
      isCommercial: false,
      planTier: "unlimited_internal",
      monthlyQuota: 0,
    },
  });
  console.log(`✅ Organization created: ${org.name} (${org.id})`);

  // 2. Create Default Admin User
  const admin = await prisma.user.upsert({
    where: { email: "admin@dovepeak.com" },
    update: {},
    create: {
      email: "admin@dovepeak.com",
      name: "Dovepeak Administrator",
      passwordHash: "!disabled", // No console login yet (roadmap Phase 1); not a usable hash
    },
  });

  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId: org.id,
        userId: admin.id,
      },
    },
    update: {},
    create: {
      organizationId: org.id,
      userId: admin.id,
      role: "OWNER",
    },
  });
  console.log(`✅ Admin user created: ${admin.email}`);

  // 3. Create Default Domain (dovepeak.com) with encrypted DKIM keys
  const existingDomain = await prisma.domain.findFirst({
    where: { organizationId: org.id, name: "dovepeak.com" },
  });

  if (!existingDomain) {
    const dkim = generateDkimKeypair();
    const encryptedPrivateKey = encryptSecret(dkim.privateKeyPem);

    const domain = await prisma.domain.create({
      data: {
        organizationId: org.id,
        name: "dovepeak.com",
        status: markDomainVerified ? "VERIFIED" : "PENDING",
        dkimSelector: env.DEFAULT_DKIM_SELECTOR,
        dkimPublicKey: dkim.dnsTxtValue,
        dkimPrivateKey: encryptedPrivateKey,
        spfVerified: markDomainVerified,
        dkimVerified: markDomainVerified,
        dmarcVerified: markDomainVerified,
        returnPathVerified: markDomainVerified,
        verifiedAt: markDomainVerified ? new Date() : null,
      },
    });
    console.log(
      markDomainVerified
        ? `✅ Domain created: ${domain.name} (marked verified for local development only)`
        : `✅ Domain created: ${domain.name} (pending; publish its DNS records and run verification)`
    );
  }

  // 4. Create Seed API Key
  const existingKey = await prisma.apiKey.findFirst({
    where: { organizationId: org.id, name: "Dovepeak Master Key", revokedAt: null },
  });

  if (!existingKey) {
    const key = generateApiKey(true);
    await prisma.apiKey.create({
      data: {
        organizationId: org.id,
        name: "Dovepeak Master Key",
        keyPrefix: key.keyPrefix,
        keyHash: key.keyHash,
        scopes: ["full_access"],
      },
    });
    console.log(`\n======================================================`);
    console.log(`🔑 INITIAL MASTER API KEY:`);
    console.log(`   ${key.plaintextKey}`);
    console.log(`   Shown once. Store it in a secret manager; never commit it.`);
    console.log(`======================================================\n`);
  }

  console.log("🎉 Seeding complete!");
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
