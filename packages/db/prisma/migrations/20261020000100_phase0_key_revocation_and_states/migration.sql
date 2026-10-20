-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'SENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmailEventType" ADD VALUE 'DEFERRED';
ALTER TYPE "EmailEventType" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ALTER COLUMN "scopes" SET DEFAULT ARRAY['emails:send']::TEXT[];

