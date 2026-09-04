-- Fizzy #2355 — 7-day recovery window for a destructively unlinked meeting.
--
-- An ARCHIVE rather than a soft-delete flag on the live rows: copying the doomed
-- rows out and then deleting for real leaves the live tables clean, so no read
-- path anywhere needs a "not deleted" predicate and none can forget one. See the
-- model doc-comment in schema.prisma for why the soft-delete shape was rejected.
CREATE TABLE IF NOT EXISTS "deleted_meeting_archive" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "joinUrl" TEXT NOT NULL,
    "subject" TEXT,
    "transcriptCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedById" TEXT NOT NULL,
    "scheduledPurgeAt" TIMESTAMP(3) NOT NULL,
    "payloadTruncated" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "deleted_meeting_archive_pkey" PRIMARY KEY ("id")
);

-- Non-CONCURRENTLY is correct here: the table is being created in this same
-- migration, so it is empty and holds no lock anyone is waiting on. The
-- CONCURRENTLY rule applies to indexes added to EXISTING tables.
CREATE INDEX IF NOT EXISTS "deleted_meeting_archive_projectId_idx"
    ON "deleted_meeting_archive"("projectId");
CREATE INDEX IF NOT EXISTS "deleted_meeting_archive_scheduledPurgeAt_idx"
    ON "deleted_meeting_archive"("scheduledPurgeAt");

ALTER TABLE "deleted_meeting_archive"
    ADD CONSTRAINT "deleted_meeting_archive_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deleted_meeting_archive"
    ADD CONSTRAINT "deleted_meeting_archive_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deleted_meeting_archive"
    ADD CONSTRAINT "deleted_meeting_archive_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
