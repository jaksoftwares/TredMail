-- CreateEnum
CREATE TYPE "EmailPriority" AS ENUM ('NORMAL', 'SYSTEM');

-- AlterEnum
ALTER TYPE "DomainStatus" ADD VALUE 'DEGRADED';

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "mtaAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "priority" "EmailPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "sendAttemptAt" TIMESTAMP(3),
ADD COLUMN     "sendRoute" TEXT;

