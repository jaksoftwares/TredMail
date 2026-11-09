-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "sendingApprovedAt" TIMESTAMP(3),
ADD COLUMN     "sendingReviewRequestedAt" TIMESTAMP(3);

-- Existing commercial workspaces predate the review, so they stay approved. New ones start unapproved.
UPDATE "organizations" SET "sendingApprovedAt" = CURRENT_TIMESTAMP WHERE "isCommercial" = true;
