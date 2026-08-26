-- #1896: carry the verbatim source quote + resolved transcript line number
-- onto each ProjectMeetingActionItem row (previously only the in-memory /
-- extractedActionItems JSON snapshot carried these fields — the API's
-- primary read path reads the relational rows, not the JSON). Both columns
-- are nullable: existing rows degrade gracefully to "no anchor available"
-- until the next brief regeneration backfills them.
ALTER TABLE "project_meeting_action_item" ADD COLUMN "sourceQuote" TEXT;
ALTER TABLE "project_meeting_action_item" ADD COLUMN "anchorLine" INTEGER;
