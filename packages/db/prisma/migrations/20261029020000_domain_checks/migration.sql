-- Pre-deployment remediation B5: automatic domain verification and re-checks.
-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "failingSince" TIMESTAMP(3),
ADD COLUMN     "lastCheckError" TEXT,
ADD COLUMN     "nextCheckAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "domains_nextCheckAt_idx" ON "domains"("nextCheckAt");


-- Check every existing domain (except suspended ones) on the first run.
UPDATE "domains" SET "nextCheckAt" = CURRENT_TIMESTAMP WHERE "status" <> 'SUSPENDED';
