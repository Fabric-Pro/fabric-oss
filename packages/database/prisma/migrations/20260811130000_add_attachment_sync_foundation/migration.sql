-- Schema foundation for bidirectional PM attachment sync (Fizzy #1746).
--
-- Every change here is additive and back-compatible: the previous app version
-- neither reads nor writes any of it, and the new columns are all either
-- nullable or carry a default, so no backfill and no table rewrite is needed.
--
--   * project.syncAttachments — per-project opt-in. Defaults to false, so the
--     upgrade turns sync ON for nobody; a project only starts syncing once an
--     admin/owner flips it.
--   * story_attachment.{sourceTool, externalAttachmentId, contentHash,
--     promotedAt, externalAuthor, externalCreatedAt} — PM-side provenance and
--     identity. All nullable with no default: NULL is exactly the state every
--     existing (Fabric-origin) row is already in, and the read paths treat
--     `source = FABRIC` as implicitly promoted.
--   * story_attachment.missingStreak — consecutive reconcile passes in which
--     the file was absent from the PM listing. NOT NULL DEFAULT 0 because 0 is
--     the correct starting value for every existing row and the debounce
--     arithmetic must never see NULL.
--   * story_attachment_sync_issue — files a reconcile pass refused to import
--     (too large, disallowed type, per-story cap). They have no bytes and no
--     StoryAttachment row, so this table is their only record. Cascades on
--     story delete, matching story_attachment.
--
-- The partial unique index that enforces per-story external-file identity is
-- deliberately NOT here: it must run CONCURRENTLY against the populated
-- story_attachment table, which Postgres forbids inside a transaction block.
-- It ships as the single-statement migration immediately after this one.
--
-- Rollback is a column/table drop — nothing outside the (not yet written) sync
-- engine reads any of it.

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "syncAttachments" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "story_attachment" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "externalAttachmentId" TEXT,
ADD COLUMN     "externalAuthor" TEXT,
ADD COLUMN     "externalCreatedAt" TIMESTAMP(3),
ADD COLUMN     "missingStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promotedAt" TIMESTAMP(3),
ADD COLUMN     "sourceTool" TEXT;

-- CreateTable
CREATE TABLE "story_attachment_sync_issue" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "sourceTool" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_attachment_sync_issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "story_attachment_sync_issue_storyId_idx" ON "story_attachment_sync_issue"("storyId");

-- AddForeignKey
ALTER TABLE "story_attachment_sync_issue" ADD CONSTRAINT "story_attachment_sync_issue_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
