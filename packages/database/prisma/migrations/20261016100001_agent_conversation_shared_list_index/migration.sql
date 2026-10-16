-- The list of sessions shared with an organization:
-- WHERE "organizationId" = $1 AND "agentId" = $2 AND "visibility" = 'ORGANIZATION'
-- ORDER BY "updatedAt" DESC. The existing ("organizationId", "agentId") index
-- leaves a filter over every member's sessions with that agent.
--
-- KEEP THIS MIGRATION TO ONE STATEMENT. Adding a second reintroduces Prisma's
-- transaction wrapper, and CONCURRENTLY cannot run inside one (SQLSTATE 25001).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_conversation_organizationId_agentId_visibility_update_idx"
  ON "agent_conversation" ("organizationId", "agentId", "visibility", "updatedAt");
