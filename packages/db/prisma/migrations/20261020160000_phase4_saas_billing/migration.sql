-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- AlterTable (the old plan columns are dropped at the end, after the backfill)
ALTER TABLE "organizations" ADD COLUMN     "sendingPauseReason" TEXT,
ADD COLUMN     "sendingPausedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedReason" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isStaff" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "priceMonthly" INTEGER NOT NULL DEFAULT 0,
    "priceYearly" INTEGER,
    "monthlyEmails" INTEGER NOT NULL,
    "dailyEmails" INTEGER NOT NULL DEFAULT 0,
    "overagePricePer1000" INTEGER,
    "overageLimit" INTEGER,
    "maxDomains" INTEGER NOT NULL DEFAULT 0,
    "maxMembers" INTEGER NOT NULL DEFAULT 0,
    "logRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL DEFAULT 'MONTH',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "periodAmountPaid" INTEGER NOT NULL DEFAULT 0,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "pendingPlanId" TEXT,
    "pendingInterval" "BillingInterval",
    "pastDueSince" TIMESTAMP(3),
    "customPrice" INTEGER,
    "customMonthlyEmails" INTEGER,
    "customDailyEmails" INTEGER,
    "customMaxDomains" INTEGER,
    "customMaxMembers" INTEGER,
    "usageAlertLevel" INTEGER NOT NULL DEFAULT 0,
    "usageClosedThrough" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "billingEmail" TEXT,
    "companyName" TEXT,
    "taxId" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "country" TEXT NOT NULL DEFAULT 'KE',
    "phone" TEXT,
    "autoCollect" BOOLEAN NOT NULL DEFAULT true,
    "creditBalance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_daily" (
    "organizationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "emails" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("organizationId","day")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "purpose" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "taxRate" INTEGER NOT NULL DEFAULT 0,
    "tax" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "amountPaid" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "billingDetails" JSONB NOT NULL,
    "metadata" JSONB,
    "notes" TEXT,
    "autoCollectedAt" TIMESTAMP(3),
    "lastReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmount" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "invoiceId" TEXT,
    "gateway" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "providerReference" TEXT,
    "providerReceipt" TEXT,
    "accountReference" TEXT,
    "payerPhone" TEXT,
    "payerName" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "initiatedById" TEXT,
    "raw" JSONB,
    "completedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_callbacks" (
    "id" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "ipAddress" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organizationId_key" ON "subscriptions"("organizationId");

-- CreateIndex
CREATE INDEX "subscriptions_currentPeriodEnd_idx" ON "subscriptions"("currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_organizationId_key" ON "billing_accounts"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_accountCode_key" ON "billing_accounts"("accountCode");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_organizationId_createdAt_idx" ON "invoices"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "invoices_status_dueAt_idx" ON "invoices"("status", "dueAt");

-- CreateIndex
CREATE INDEX "invoice_lines_invoiceId_idx" ON "invoice_lines"("invoiceId");

-- CreateIndex
CREATE INDEX "payments_organizationId_createdAt_idx" ON "payments"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_gateway_providerReference_key" ON "payments"("gateway", "providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_gateway_providerReceipt_key" ON "payments"("gateway", "providerReceipt");

-- CreateIndex
CREATE INDEX "payment_callbacks_gateway_createdAt_idx" ON "payment_callbacks"("gateway", "createdAt");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Default price list (KES, amounts in cents). Staff can change prices and limits later
-- in the back-office; existing rows are left alone.
INSERT INTO "plans" ("id", "name", "description", "currency", "priceMonthly", "priceYearly", "monthlyEmails", "dailyEmails", "overagePricePer1000", "overageLimit", "maxDomains", "maxMembers", "logRetentionDays", "features", "isPublic", "isActive", "sortOrder", "updatedAt") VALUES
  ('free', 'Free', 'For trying TredMail and small projects.', 'KES', 0, NULL, 3000, 100, NULL, NULL, 1, 3, 7, ARRAY['3,000 emails per month', '100 emails per day', '1 sending domain', '7 days of email logs', 'API, SMTP relay and webhooks'], true, true, 0, CURRENT_TIMESTAMP),
  ('pro', 'Pro', 'For production applications.', 'KES', 250000, 2500000, 50000, 5000, 12000, 100000, 10, 10, 30, ARRAY['50,000 emails per month', 'Extra emails KES 120 per 1,000', '10 sending domains', '30 days of email logs', 'Templates, scheduling and webhooks'], true, true, 10, CURRENT_TIMESTAMP),
  ('scale', 'Scale', 'For high-volume senders.', 'KES', 1150000, 11500000, 100000, 20000, 10000, 400000, 0, 0, 60, ARRAY['100,000 emails per month', 'Extra emails KES 100 per 1,000', 'Unlimited domains and members', '60 days of email logs', 'Priority support'], true, true, 20, CURRENT_TIMESTAMP),
  ('enterprise', 'Enterprise', 'Custom volume, price and terms, arranged with Dovepeak.', 'KES', 0, NULL, 0, 0, NULL, NULL, 0, 0, 90, ARRAY['Custom volume and price', 'Dedicated IP with managed warm-up', 'Invoiced billing'], false, true, 30, CURRENT_TIMESTAMP),
  ('internal', 'Internal', 'Dovepeak Technologies'' own workspaces.', 'KES', 0, NULL, 0, 0, NULL, NULL, 0, 0, 395, ARRAY['Unlimited'], false, true, 100, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- One subscription per existing workspace, on the plan it had
INSERT INTO "subscriptions" ("id", "organizationId", "planId", "interval", "status", "currentPeriodStart", "currentPeriodEnd", "updatedAt")
SELECT
  'sub_' || replace(gen_random_uuid()::text, '-', ''),
  o."id",
  CASE
    WHEN o."planTier" = 'unlimited_internal' THEN 'internal'
    WHEN o."planTier" IN ('pro', 'scale', 'enterprise') THEN o."planTier"
    ELSE 'free'
  END,
  'MONTH',
  'ACTIVE',
  date_trunc('day', CURRENT_TIMESTAMP),
  date_trunc('day', CURRENT_TIMESTAMP) + INTERVAL '1 month',
  CURRENT_TIMESTAMP
FROM "organizations" o
ON CONFLICT ("organizationId") DO NOTHING;

-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "monthlyQuota",
DROP COLUMN "planTier";
