-- Clears the question and answer text that turns kept after their
-- conversation was deleted before 20261016160000 added the trigger that
-- clears it on delete. A turn whose conversation is gone has a NULL
-- "conversationId" and a non-NULL "scopeConversationId"; a turn that never had
-- a conversation (e.g. Nexus) has both NULL and keeps its text.
--
-- The row itself stays: it carries attribution and the token ledger.
-- Idempotent: a second run matches no rows.

UPDATE "conversation_turn"
   SET "questionText" = NULL,
       "responseText" = NULL
 WHERE "conversationId" IS NULL
   AND "scopeConversationId" IS NOT NULL
   AND ("questionText" IS NOT NULL OR "responseText" IS NOT NULL);
