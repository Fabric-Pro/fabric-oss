-- CreateEnum
CREATE TYPE "problem_log_category" AS ENUM ('SYSTEM_ERROR', 'INTEGRATION_FAILURE', 'BACKGROUND_JOB_FAILURE', 'NOTIFICATION_FAILURE', 'SECURITY_EVENT', 'DATA_PIPELINE_FAILURE', 'SLA_BREACH', 'PROJECT_ISSUE', 'PROJECT_BLOCKER', 'PROJECT_RISK');

-- CreateEnum
CREATE TYPE "problem_log_severity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "problem_log_status" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "problem_log_review_state" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "problem_log_source_type" AS ENUM ('SYSTEM_EVENT', 'MEETING_TRANSCRIPT', 'CHAT_THREAD', 'DOCUMENT');

-- CreateTable
CREATE TABLE "problem_log_entry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "affectedUserId" TEXT,
    "category" "problem_log_category" NOT NULL,
    "severity" "problem_log_severity" NOT NULL,
    "status" "problem_log_status" NOT NULL DEFAULT 'OPEN',
    "reviewState" "problem_log_review_state" NOT NULL DEFAULT 'CONFIRMED',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "sourceType" "problem_log_source_type" NOT NULL DEFAULT 'SYSTEM_EVENT',
    "sourceId" TEXT,
    "sourceQuote" TEXT,
    "dedupKey" TEXT NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "problem_log_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "problem_log_entry_organizationId_projectId_lastSeenAt_idx" ON "problem_log_entry"("organizationId", "projectId", "lastSeenAt" DESC);

-- CreateIndex
CREATE INDEX "problem_log_entry_projectId_reviewState_idx" ON "problem_log_entry"("projectId", "reviewState");

-- CreateIndex
CREATE UNIQUE INDEX "problem_log_entry_organizationId_dedupKey_key" ON "problem_log_entry"("organizationId", "dedupKey");

-- AddForeignKey
ALTER TABLE "problem_log_entry" ADD CONSTRAINT "problem_log_entry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_log_entry" ADD CONSTRAINT "problem_log_entry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
