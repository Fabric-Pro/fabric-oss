-- Re-point AnswerSource.AI_EDITED to its literal meaning, and move the old rows.
--
-- AI_EDITED was defined as "a recommendation was offered but the PO typed their
-- own answer". That was never an edit: the answer box opened EMPTY, so nothing
-- was taken from the AI. There was no way to start from a suggestion and change
-- it, so the value the name describes had no path to produce it.
--
-- This release adds that path — a suggestion can now be opened in the editor,
-- pre-filled, and modified — so AI_EDITED is reserved for it, and the old rows
-- move to MANUAL, which is what they always were.
--
-- Safe to sweep every existing row because the client is the ONLY writer of this
-- value: it is set in the Summary + Questions panel and validated through the
-- maturation API schema. No agent, MCP tool, seed or backfill path writes
-- answerSource, so an AI_EDITED row here can only have come from the typed-own
-- flow that this migration reclassifies.
--
-- Note for whoever reads AI-adoption reporting: this retroactively moves
-- historical "edited" answers into "manual". That is the correction, not a
-- regression — those answers were never edits.
--
-- Idempotent: re-running matches nothing.
UPDATE "decision_log_entry"
   SET "answerSource" = 'MANUAL'
 WHERE "answerSource" = 'AI_EDITED';
