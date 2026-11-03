-- AlterTable
ALTER TABLE "newsletter_settings" ADD COLUMN     "orgSyncError" TEXT,
ADD COLUMN     "orgSyncedAt" TIMESTAMP(3),
ADD COLUMN     "sendToOrganization" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "newsletter_subscriber" ADD COLUMN     "excludedAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL';
