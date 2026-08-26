-- Data migration: rename AgentConversation.agentId "fabric-ai" → "fabric-workspace-assistant"
--
-- Background (Fizzy #1412 round-2 cleanup, follows PR #1236):
-- The frontend previously used the URL-slug form `"fabric-ai"` as the
-- `AgentConversation.agentId` value at three call sites (FabricDirectChat,
-- useOrchestratorConversation, FabricAIClient). The seeded
-- `RegisteredAgent.agentId` is the canonical `"fabric-workspace-assistant"`.
-- PR #1236 added a `fabric-ai` compat alias to seed-system-agents.ts to
-- unblock the round-2 catalog validation; this PR migrates existing
-- AgentConversation rows to the canonical id, updates the frontend call
-- sites, and removes the alias entry.
--
-- This migration touches ONLY the `agent_conversation` table — orchestrator
-- routing identifiers ("fabric-ai" in useOrchestratorStream, AgentTask
-- comparisons, fabric-ai-handler.name, etc.) are a SEPARATE concept and are
-- intentionally NOT migrated.
--
-- Safety notes:
-- * Idempotent: re-running this migration on already-migrated rows is a
--   no-op (the WHERE clause excludes already-canonical rows).
-- * Tenant-scope safe: AgentConversation rows are isolated by userId +
--   organizationId; this migration only rewrites the agentId column and
--   does not touch isolation columns.
-- * Reversible: the inverse migration would simply rewrite back, but
--   note that the seed alias removal (in the same PR) means the inverse
--   would leave rows pointing at a non-existent agentId until the alias
--   is re-seeded. Roll back the SEED change in lockstep with this
--   migration if a rollback is needed.

UPDATE "agent_conversation"
SET "agentId" = 'fabric-workspace-assistant'
WHERE "agentId" = 'fabric-ai';
