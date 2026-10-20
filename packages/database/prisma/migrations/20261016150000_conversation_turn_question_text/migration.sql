-- The question a turn was admitted with, so a turn the browser never saved
-- (still running, or its stream ended before the save) keeps its question
-- on reload. Additive and nullable: a metadata-only change, no table rewrite;
-- turns admitted before it simply have none.
ALTER TABLE "conversation_turn" ADD COLUMN "questionText" TEXT;
