-- CreateEnum
CREATE TYPE "AiUsageBillingCategory" AS ENUM ('INCLUDED_CREDIT', 'STRIPE_METERED', 'EXTERNAL_BYOK', 'PLATFORM_UNBILLED');

-- AlterTable
ALTER TABLE "ai_usage_log" ADD COLUMN     "billingCategory" "AiUsageBillingCategory",
ADD COLUMN     "billingCustomerId" TEXT;

-- CreateIndex
CREATE INDEX "ai_usage_log_billingCategory_createdAt_idx" ON "ai_usage_log"("billingCategory", "createdAt");
