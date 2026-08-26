-- Decision tagging, ownership and duration classification (Fizzy #2029):
-- a per-project decision-type taxonomy plus type/owner/duration/priority
-- metadata on architecture decisions (and their version snapshots).

-- CreateEnum
CREATE TYPE "decision_duration" AS ENUM ('LONG_STANDING', 'SHORT_TERM');

-- CreateEnum
CREATE TYPE "decision_type_origin" AS ENUM ('AI', 'HUMAN');

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'DECISION_OWNER_ASSIGNED';

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'DECISION_OWNER_UPDATED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DECISION_OWNER_ASSIGNED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DECISION_OWNER_UPDATED';

-- CreateTable
CREATE TABLE "decision_type" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "origin" "decision_type_origin" NOT NULL DEFAULT 'HUMAN',
    "archivedAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decision_type_pkey" PRIMARY KEY ("id")
);

-- AlterTable: tagging metadata on decisions (all nullable/defaulted so legacy
-- rows stay valid until touched or backfilled)
ALTER TABLE "architecture_decision" ADD COLUMN "decisionTypeId" TEXT,
ADD COLUMN "ownerUserId" TEXT,
ADD COLUMN "duration" "decision_duration",
ADD COLUMN "priorityFlagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "priorityFlaggedAt" TIMESTAMP(3);

-- AlterTable: the same metadata snapshotted per version
ALTER TABLE "architecture_decision_version" ADD COLUMN "decisionTypeId" TEXT,
ADD COLUMN "ownerUserId" TEXT,
ADD COLUMN "duration" "decision_duration",
ADD COLUMN "priorityFlagged" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "decision_type_projectId_name_key" ON "decision_type"("projectId", "name");

-- CreateIndex
CREATE INDEX "decision_type_projectId_idx" ON "decision_type"("projectId");

-- CreateIndex
CREATE INDEX "decision_type_userId_idx" ON "decision_type"("userId");

-- CreateIndex
CREATE INDEX "decision_type_organizationId_idx" ON "decision_type"("organizationId");

-- The priority index on the POPULATED architecture_decision table is built
-- CONCURRENTLY in the follow-up single-statement migration to avoid an
-- extended write lock on deploy.

-- AddForeignKey
-- migration-lint: allow unvalidated-constraint — FK targets decision_type,
-- created empty in THIS migration, on a brand-new all-NULL column; validation
-- scans zero matching rows and cannot fail, so deferring it has nothing to save.
ALTER TABLE "architecture_decision" ADD CONSTRAINT "architecture_decision_decisionTypeId_fkey" FOREIGN KEY ("decisionTypeId") REFERENCES "decision_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_type" ADD CONSTRAINT "decision_type_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_type" ADD CONSTRAINT "decision_type_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_type" ADD CONSTRAINT "decision_type_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
