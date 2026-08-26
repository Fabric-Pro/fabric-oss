-- CreateEnum
CREATE TYPE "test_result" AS ENUM ('NOT_RUN', 'PASSED', 'FAILED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "result_source" AS ENUM ('MANUAL', 'PM_SYNC');

-- AlterTable
ALTER TABLE "test_case" ADD COLUMN     "currentResult" "test_result" NOT NULL DEFAULT 'NOT_RUN',
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "lastRunByLabel" TEXT,
ADD COLUMN     "lastRunSource" "result_source";

-- CreateTable
CREATE TABLE "test_result_event" (
    "id" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "result" "test_result" NOT NULL,
    "source" "result_source" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedByUserId" TEXT,
    "actorLabel" TEXT,
    "testPlanId" TEXT,
    "externalRunRef" TEXT,
    "externalRunUrl" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_result_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_result_event_testCaseId_occurredAt_idx" ON "test_result_event"("testCaseId", "occurredAt");

-- CreateIndex
CREATE INDEX "test_result_event_testPlanId_idx" ON "test_result_event"("testPlanId");

-- AddForeignKey
ALTER TABLE "test_result_event" ADD CONSTRAINT "test_result_event_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_result_event" ADD CONSTRAINT "test_result_event_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_result_event" ADD CONSTRAINT "test_result_event_testPlanId_fkey" FOREIGN KEY ("testPlanId") REFERENCES "test_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
