-- Pre-deployment remediation phase 5: per-workspace tracking defaults, bot-flagged tracking
-- events, one-click unsubscribe.
-- AlterEnum
ALTER TYPE "EmailEventType" ADD VALUE 'UNSUBSCRIBED';

-- AlterTable
ALTER TABLE "email_events" ADD COLUMN     "bot" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "unsubscribeLink" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "trackClicksDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trackOpensDefault" BOOLEAN NOT NULL DEFAULT false;


-- Workspaces that exist today keep tracking on, as it was before; new workspaces start with it off.
UPDATE "organizations" SET "trackOpensDefault" = true, "trackClicksDefault" = true;
