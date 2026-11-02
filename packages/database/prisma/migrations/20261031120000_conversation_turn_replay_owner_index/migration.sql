-- Build the replay ownership key without blocking writes to existing turns.
CREATE UNIQUE INDEX CONCURRENTLY "conversation_turn_id_organizationId_userId_key" ON "conversation_turn"("id", "organizationId", "userId");
