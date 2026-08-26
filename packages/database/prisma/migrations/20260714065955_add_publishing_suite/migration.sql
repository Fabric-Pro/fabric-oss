-- CreateEnum
CREATE TYPE "publishing_cycle_status" AS ENUM ('GENERATING', 'READY', 'NO_TOPICS', 'INSUFFICIENT_CONTEXT', 'FAILED');
-- CreateEnum
CREATE TYPE "publishing_topic_status" AS ENUM ('SUGGESTION', 'SELECTED', 'IN_PROGRESS', 'PUBLISHED', 'DECLINED', 'DEFERRED');
-- CreateEnum
CREATE TYPE "publishing_topic_origin" AS ENUM ('AI', 'MANUAL');
-- CreateTable
CREATE TABLE "publishing_suggestion_cycle" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "status" "publishing_cycle_status" NOT NULL DEFAULT 'GENERATING',
    "actorUserId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "executionTimeoutAt" TIMESTAMP(3),
    "coveredThrough" TIMESTAMP(3) NOT NULL,
    "sourceCoverage" JSONB,
    "sourceFailures" JSONB,
    "temporalWorkflowId" TEXT,
    "error" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "publishing_suggestion_cycle_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "publishing_topic" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "cycleId" TEXT,
    "title" TEXT NOT NULL,
    "pitch" TEXT,
    "status" "publishing_topic_status" NOT NULL DEFAULT 'SUGGESTION',
    "origin" "publishing_topic_origin" NOT NULL,
    "createdById" TEXT,
    "declineReason" TEXT,
    "provenance" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "publishing_topic_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "publishing_suggestion_cycle_projectId_createdAt_idx" ON "publishing_suggestion_cycle"("projectId", "createdAt");
-- CreateIndex
CREATE INDEX "publishing_suggestion_cycle_organizationId_idx" ON "publishing_suggestion_cycle"("organizationId");
-- CreateIndex
CREATE INDEX "publishing_suggestion_cycle_userId_idx" ON "publishing_suggestion_cycle"("userId");
-- CreateIndex
CREATE INDEX "publishing_topic_projectId_status_idx" ON "publishing_topic"("projectId", "status");
-- CreateIndex
CREATE INDEX "publishing_topic_cycleId_idx" ON "publishing_topic"("cycleId");
-- CreateIndex
CREATE UNIQUE INDEX "publishing_topic_projectId_dedupeKey_key" ON "publishing_topic"("projectId", "dedupeKey");
-- AddForeignKey
ALTER TABLE "publishing_suggestion_cycle" ADD CONSTRAINT "publishing_suggestion_cycle_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "publishing_suggestion_cycle" ADD CONSTRAINT "publishing_suggestion_cycle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "publishing_suggestion_cycle" ADD CONSTRAINT "publishing_suggestion_cycle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "publishing_topic" ADD CONSTRAINT "publishing_topic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "publishing_topic" ADD CONSTRAINT "publishing_topic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "publishing_topic" ADD CONSTRAINT "publishing_topic_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "publishing_topic" ADD CONSTRAINT "publishing_topic_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "publishing_suggestion_cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One active (GENERATING) suggestion cycle per project. A second run while one
-- is in flight hits this constraint; the dispatch/create-or-get path reads back
-- the active row. A FAILED cycle frees the slot for retries.
CREATE UNIQUE INDEX "publishing_suggestion_cycle_active"
  ON "publishing_suggestion_cycle"("projectId")
  WHERE "status" = 'GENERATING';
