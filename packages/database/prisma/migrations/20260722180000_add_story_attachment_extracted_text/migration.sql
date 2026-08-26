-- AlterTable: cache for text extracted from a context-only (UNLOCKED) ticket
-- attachment, so a ticket-level AI run extracts each file once instead of on
-- every run. Populated lazily by the AI-context resolver, never at upload.
--
-- Both columns are nullable with no default and no backfill: NULL means "not
-- yet extracted OR not extractable", which is exactly the state every existing
-- row is in. Rollback is a column drop — nothing reads these outside the
-- resolver, and the resolver treats NULL as a cache miss.
ALTER TABLE "story_attachment"
  ADD COLUMN "extractedText" TEXT,
  ADD COLUMN "extractedAt" TIMESTAMP(3);
