-- Manual time tracking: members log confirmed time against projects.
--
-- The new columns on "project" and "organization" are constant-default or
-- nullable, so Postgres records them in the catalog without rewriting either
-- table, and the previous app version, which never reads them, is unaffected.

-- CreateEnum
CREATE TYPE "ProjectBillingModel" AS ENUM ('FIXED_BID', 'TIME_AND_MATERIALS');

-- CreateEnum
CREATE TYPE "TimeActivity" AS ENUM ('PLANNING_REQUIREMENTS', 'DESIGN_UX', 'DEVELOPMENT', 'CODE_REVIEW', 'TESTING', 'MEETINGS_COLLABORATION', 'OTHER');

-- AlterTable
ALTER TABLE "organization" ADD COLUMN "timeRequireStartStop" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "timeDefaultBillable" BOOLEAN;

-- AlterTable
ALTER TABLE "project" ADD COLUMN "billingModel" "ProjectBillingModel" NOT NULL DEFAULT 'FIXED_BID',
ADD COLUMN "timeRequireStartStop" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "timeDefaultBillable" BOOLEAN;

-- CreateTable
CREATE TABLE "time_entry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "startAt" TIMESTAMPTZ(3),
    "stopAt" TIMESTAMPTZ(3),
    "activity" "TimeActivity" NOT NULL,
    "billable" BOOLEAN NOT NULL,
    "description" TEXT,
    "storyId" TEXT,
    "storyIdentifier" TEXT,
    "storyTitle" TEXT,
    "startStopRequired" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_entry_userId_workDate_idx" ON "time_entry"("userId", "workDate");

-- CreateIndex
CREATE INDEX "time_entry_organizationId_projectId_workDate_idx" ON "time_entry"("organizationId", "projectId", "workDate");

-- CreateIndex
CREATE INDEX "time_entry_storyId_idx" ON "time_entry"("storyId");

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE SET NULL ON UPDATE CASCADE;
