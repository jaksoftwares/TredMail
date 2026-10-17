import { prisma } from "./client.js";
import { generateDkimKeypair } from "../security/dkim-keys.js";
import { encryptSecret } from "../security/crypto.js";
import { generateApiKey } from "../security/api-keys.js";

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
      passwordHash: "seeded_local_admin", // Can be updated in Console
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
        status: "VERIFIED",
        dkimSelector: "tredmail",
        dkimPublicKey: dkim.dnsTxtValue,
        dkimPrivateKey: encryptedPrivateKey,
        spfVerified: true,
        dkimVerified: true,
        dmarcVerified: true,
        returnPathVerified: true,
        verifiedAt: new Date(),
      },
    });
    console.log(`✅ Domain created & verified: ${domain.name}`);
  }

  // 4. Create Seed API Key
  const existingKey = await prisma.apiKey.findFirst({
    where: { organizationId: org.id, name: "Dovepeak Master Key" },
  });

  if (!existingKey) {
    const key = generateApiKey(true);
    await prisma.apiKey.create({
      data: {
        organizationId: org.id,
        name: "Dovepeak Master Key",
        keyPrefix: key.keyPrefix,
        keyHash: key.keyHash,
        scopes: ["email:send", "domains:read", "domains:write", "admin"],
      },
    });
    console.log(`\n======================================================`);
    console.log(`🔑 INITIAL MASTER API KEY:`);
    console.log(`   ${key.plaintextKey}`);
    console.log(`   (Save this key in your .env or API clients!)`);
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
