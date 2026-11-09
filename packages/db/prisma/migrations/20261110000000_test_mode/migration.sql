-- AlterEnum
ALTER TYPE "EmailEventType" ADD VALUE 'TEST_MODE';

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;
