/**
 * Grants or removes TredMail staff access (the back-office at /admin) for a console user.
 *
 *   npm run staff -- grant someone@dovepeakdigital.com
 *   npm run staff -- revoke someone@dovepeakdigital.com
 *   npm run staff -- list
 *   node dist/cli/staff.js grant someone@dovepeakdigital.com   (production image)
 *
 * The person must have signed up first. In production, staff must also turn on two-factor
 * authentication before the back-office opens for them.
 */
import { prisma } from "@tredmail/db";

async function main() {
  const [command, rawEmail] = process.argv.slice(2);
  if (command === "list") {
    const staff = await prisma.user.findMany({ where: { isStaff: true }, select: { email: true, twoFactorEnabled: true }, orderBy: { email: "asc" } });
    if (staff.length === 0) console.log("No staff accounts.");
    for (const user of staff) console.log(`${user.email}${user.twoFactorEnabled ? "" : "  (two-factor not enabled)"}`);
    return;
  }
  const email = rawEmail?.trim().toLowerCase();
  if ((command !== "grant" && command !== "revoke") || !email) {
    console.error("Usage: staff grant <email> | staff revoke <email> | staff list");
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No console user with the address ${email}. They need to sign up first.`);
    process.exit(1);
  }
  await prisma.user.update({ where: { id: user.id }, data: { isStaff: command === "grant" } });
  console.log(command === "grant" ? `${email} is now TredMail staff.` : `${email} is no longer TredMail staff.`);
  if (command === "grant" && !user.twoFactorEnabled) {
    console.log("They must enable two-factor authentication (Settings > Security) before the back-office opens in production.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
