-- Newsletter approval gate (Fizzy 1869).

-- 1) Per-project opt-in.
ALTER TABLE "newsletter_settings" ADD COLUMN "requireApproval" BOOLEAN NOT NULL DEFAULT false;

-- 2) Send-row: frozen config + review columns.
ALTER TABLE "newsletter_send" ADD COLUMN "requireApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "newsletter_send" ADD COLUMN "chatChannels" JSONB;
ALTER TABLE "newsletter_send" ADD COLUMN "reviewedByUserId" TEXT;
ALTER TABLE "newsletter_send" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "newsletter_send" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "newsletter_send" ADD COLUMN "removedHighlightIndexes" JSONB;

-- 3) Widen the "one active send per project" partial unique index so a held or
--    in-flight-approved draft occupies the slot and a second draft cannot stack.
DROP INDEX "newsletter_send_active";
CREATE UNIQUE INDEX "newsletter_send_active" ON "newsletter_send"("projectId")
  WHERE "status" IN ('PENDING', 'PENDING_APPROVAL', 'APPROVED');

-- 4) New in-app notification type (enum add).
-- AlterEnum
-- `IF NOT EXISTS` keeps the ADD VALUE idempotent across half-applied deploys
-- (mirrors 20260622120000_add_report_notification_types / 20260706120000_add_story_shared_notification_type).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'NEWSLETTER_APPROVAL_PENDING';
