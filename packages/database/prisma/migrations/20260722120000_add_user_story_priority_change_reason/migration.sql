-- Denormalised rationale of the newest priority-band change, mirroring
-- StoryPriorityChange.reason for the latest row. Lets the Roadmap Priority list
-- show the "why" inline per row without an N+1 join. NULL = last change had no
-- comment, or the band never changed.
ALTER TABLE "user_story" ADD COLUMN "priorityChangeReason" TEXT;
