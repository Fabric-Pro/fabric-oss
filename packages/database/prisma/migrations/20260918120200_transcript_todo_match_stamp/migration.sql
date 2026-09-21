-- The to-do owner matcher's stamp on a meeting transcript (Fizzy #2340).
--
-- Trimmed by hand from a generated diff, which also proposed index renames and
-- constraint drops belonging to other work already accumulated in the schema.
-- None of that is this change.
--
-- Deliberately separate from actionItemsLinkedAt / actionItemsLinkVersion.
-- Those belong to #1902's action-item-to-work-item linker, which short-circuits
-- on its own version; a matcher stamping them would make the linker believe a
-- meeting was already linked, and the reverse. Two features, two stamps.
--
-- Both nullable with no default, so this is a metadata-only change: no table
-- rewrite, no backfill, and every existing transcript reads as "never matched",
-- which is exactly right — nothing has been matched yet.
ALTER TABLE "project_meeting_transcript" ADD COLUMN "todoMatchVersion" INTEGER,
ADD COLUMN "todosMatchedAt" TIMESTAMP(3);
