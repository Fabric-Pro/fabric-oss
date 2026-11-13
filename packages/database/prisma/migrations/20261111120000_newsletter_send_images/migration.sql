-- Reviewers can attach images to the highlights of a held release-notes send.
--
-- Settings carry the per-project switch; each send freezes it at creation like
-- `requireApproval`, and records the reviewer's highlight order at approval.
-- Both new booleans default to false and the order column is nullable, so
-- existing rows need no backfill and the previous app version keeps working.
--
-- Tenancy: `newsletter_send_image` carries the same XOR tenant columns as its
-- sibling newsletter tables and is registered as `user_owned` in
-- scripts/apply-rls-direct.ts.

-- AlterTable
ALTER TABLE "newsletter_settings" ADD COLUMN "screenshotsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "newsletter_send" ADD COLUMN "screenshotsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "newsletter_send" ADD COLUMN "highlightOrder" JSONB;

-- CreateTable
CREATE TABLE "newsletter_send_image" (
    "id" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "highlightIndex" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "captureState" TEXT NOT NULL DEFAULT 'READY',
    "included" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "storageKey" TEXT,
    "publicKey" TEXT,
    "altText" TEXT NOT NULL DEFAULT '',
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "prompt" TEXT,
    "errorMessage" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newsletter_send_image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "newsletter_send_image_sendId_idx" ON "newsletter_send_image"("sendId");

-- CreateIndex
CREATE INDEX "newsletter_send_image_userId_idx" ON "newsletter_send_image"("userId");

-- CreateIndex
CREATE INDEX "newsletter_send_image_organizationId_idx" ON "newsletter_send_image"("organizationId");

-- AddForeignKey
ALTER TABLE "newsletter_send_image" ADD CONSTRAINT "newsletter_send_image_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "newsletter_send"("id") ON DELETE CASCADE ON UPDATE CASCADE;
