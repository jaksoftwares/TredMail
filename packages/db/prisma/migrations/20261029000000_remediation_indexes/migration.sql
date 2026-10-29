-- Pre-deployment remediation M5: indexes for the background jobs, and a real column for
-- delivery-event de-duplication (previously a JSON path lookup in details).

-- AlterTable
ALTER TABLE "email_events" ADD COLUMN     "dedupeKey" TEXT;

-- Backfill from details. If a race stored the same report twice, only the earliest row keeps
-- the key, so the unique index below can be created.
UPDATE "email_events" AS ev
SET "dedupeKey" = ranked.key
FROM (
  SELECT "id", "details"->>'dedupeKey' AS key,
         row_number() OVER (PARTITION BY "emailId", "details"->>'dedupeKey' ORDER BY "timestamp", "id") AS n
  FROM "email_events"
  WHERE "details" ? 'dedupeKey' AND "details"->>'dedupeKey' IS NOT NULL
) AS ranked
WHERE ev."id" = ranked."id" AND ranked.n = 1;

-- CreateIndex
CREATE INDEX "email_events_type_timestamp_idx" ON "email_events"("type", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "email_events_emailId_dedupeKey_key" ON "email_events"("emailId", "dedupeKey");

-- CreateIndex
CREATE INDEX "emails_status_updatedAt_idx" ON "emails"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "emails_domainId_idx" ON "emails"("domainId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");
