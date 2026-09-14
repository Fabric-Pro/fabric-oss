-- An ADVISORY lock on a shared publishing working draft (Fizzy #1851, deck call 05).
--
-- `publishing_topic_working_draft` is unique on (topicId, postType): one draft
-- per content type for the WHOLE topic, not one per author. Two people editing
-- is therefore a real collision, and until now the only signal was a CONFLICT
-- on save, after the words were typed.
--
-- Advisory, never enforcing. These two columns name who is in the draft and
-- when that claim goes stale; nothing reads them to refuse a write. Take-over
-- is always available, and it is non-destructive because every prior body is
-- reachable through the draft version list -- which is why the lock was
-- sequenced after that read path rather than before it.
--
-- Both nullable with no default and no backfill: an existing row is simply
-- unclaimed, which is the correct reading of "nobody was editing it".
ALTER TABLE "publishing_topic_working_draft"
  ADD COLUMN "editingUserId" TEXT,
  ADD COLUMN "editingExpiresAt" TIMESTAMP(3);

-- NO foreign key on the holder, deliberately. It would buy only SetNull when
-- an account goes away, and a claim already expires on its own after ten
-- minutes, so a departed user's lock self-heals without one. `sourceDraftId`
-- on this same table is a plain column for a related reason. Skipping it also
-- keeps this migration off the expand/contract path an ADD CONSTRAINT forces.

-- CONCURRENTLY and alone in its own statement: the migration linter refuses a
-- blocking CREATE INDEX on an existing table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "publishing_topic_working_draft_editingUserId_idx"
  ON "publishing_topic_working_draft"("editingUserId");
