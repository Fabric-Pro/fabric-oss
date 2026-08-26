-- Backfill the denormalised inline note from each story's NEWEST priority
-- change. In a normal deploy this is a no-op: the history table is created in
-- this same migration batch, so it is empty when this runs. It exists for
-- environments that took the migrations incrementally during development
-- (dev DBs that wrote history rows before this column landed) — there, items
-- whose latest change predates the column would otherwise show no "why"
-- despite their history carrying one.
--
-- Only the newest change's reason is mirrored (an older comment against a
-- newer band would misattribute), and rows the app has already written are
-- left alone.
UPDATE "user_story" us
SET "priorityChangeReason" = latest.reason
FROM (
    SELECT DISTINCT ON ("storyId") "storyId", reason
    FROM "story_priority_change"
    ORDER BY "storyId", "createdAt" DESC, id DESC
) latest
WHERE latest."storyId" = us.id
  AND latest.reason IS NOT NULL
  AND us."priorityChangeReason" IS NULL;
