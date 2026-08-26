-- AlterTable
ALTER TABLE "publishing_topic" ADD COLUMN     "snoozeReason" TEXT,
ADD COLUMN     "snoozedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "publishing_topic_read" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publishing_topic_read_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "publishing_topic_read_userId_projectId_idx" ON "publishing_topic_read"("userId", "projectId");

-- CreateIndex
CREATE INDEX "publishing_topic_read_organizationId_idx" ON "publishing_topic_read"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_topic_read_topicId_userId_key" ON "publishing_topic_read"("topicId", "userId");

-- AddForeignKey
ALTER TABLE "publishing_topic_read" ADD CONSTRAINT "publishing_topic_read_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "publishing_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_read" ADD CONSTRAINT "publishing_topic_read_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_read" ADD CONSTRAINT "publishing_topic_read_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1D (Fizzy #2265). Existing DEFERRED topics re-surface for re-triage: they
-- become ordinary suggestions with no active snooze. This is LOSSY AND
-- IRREVERSIBLE — a deferred topic's pre-deferral status was never stored, so
-- nothing could restore it either, and the PUBLISHING_INBOX flag does not undo
-- it (the flag governs which view renders, not what the rows hold).
--
-- Bounded by a literal predicate over a small table, so `unbatched-backfill`
-- does not fire: that rule targets an UPDATE with no WHERE, an UPDATE ... FROM,
-- or a subquery-driven predicate. This is none of those.
--
-- The DEFERRED enum VALUE deliberately survives this migration and is dropped
-- in slice 1D-1b. Draining it of rows here is what makes that later drop safe.
UPDATE "publishing_topic" SET "status" = 'SUGGESTION' WHERE "status" = 'DEFERRED';
