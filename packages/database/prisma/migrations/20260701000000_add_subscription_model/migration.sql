-- CreateEnum
CREATE TYPE "SubscriptionSubjectType" AS ENUM ('DOCUMENT', 'FEATURE');

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'SUBSCRIPTION';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'DOCUMENT_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'FEATURE_UPDATED';

-- CreateTable
CREATE TABLE "subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "subjectType" "SubscriptionSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscription_subjectType_subjectId_idx" ON "subscription"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "subscription_userId_organizationId_idx" ON "subscription"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_userId_subjectType_subjectId_key" ON "subscription"("userId", "subjectType", "subjectId");

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

