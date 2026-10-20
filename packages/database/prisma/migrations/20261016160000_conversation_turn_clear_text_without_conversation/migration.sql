-- A turn row outlives its conversation: deleting the conversation sets
-- "conversationId" to NULL (ON DELETE SET NULL) and keeps the row, through
-- "scopeConversationId", for attribution and the token ledger. The question
-- and answer it carried are the conversation's content and go with it.
--
-- One BEFORE UPDATE trigger covers every way a conversation is deleted (a
-- single delete, a project's or story's bulk delete, raw SQL): the SET NULL
-- is an UPDATE of the turn row. It fires when a turn loses the conversation
-- it had, which includes a turn admitted without one and claimed by the
-- conversation's first save (its "scopeConversationId" stays NULL), and on
-- any later write to a turn whose conversation is gone, so the answer of a
-- run that finishes after the delete is not kept either. A turn that never
-- had a conversation (e.g. Nexus) keeps its text.
--
-- Rows whose conversation was deleted before this migration keep their text;
-- clearing them is a separate data change. Idempotent.

CREATE OR REPLACE FUNCTION conversation_turn_clear_text_without_conversation()
RETURNS TRIGGER AS $$
BEGIN
  NEW."questionText" := NULL;
  NEW."responseText" := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversation_turn_clear_text_without_conversation
  ON "conversation_turn";

CREATE TRIGGER conversation_turn_clear_text_without_conversation
  BEFORE UPDATE ON "conversation_turn"
  FOR EACH ROW
  WHEN (
    NEW."conversationId" IS NULL
    AND (NEW."scopeConversationId" IS NOT NULL OR OLD."conversationId" IS NOT NULL)
  )
  EXECUTE FUNCTION conversation_turn_clear_text_without_conversation();
