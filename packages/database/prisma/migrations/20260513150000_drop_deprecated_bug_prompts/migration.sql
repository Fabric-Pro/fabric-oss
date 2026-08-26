-- F-171 follow-up cleanup: remove the deprecated SYSTEM bug prompts
-- (bug_placeholder, bug_triage, bug_draft) from PR #903. The earlier
-- F-171 migration (20260513120000_align_bug_workflow_f171) only deleted
-- the PromptBindings that referenced them, leaving the Prompt + PromptVersion
-- rows orphaned. They appear in the Prompts settings list but have no
-- active binding so they don't fire at runtime — confusing UX. Drop them.
--
-- Schema notes:
--   - PromptVersion.promptId has onDelete: Cascade, so versions go with the
--     parent automatically.
--   - Prompt.forkedFromId has no explicit onDelete clause, so Prisma defaults
--     to Restrict. We null out forkedFromId on any ORG/USER forks before
--     deleting the SYSTEM parents — preserves the user content, just severs
--     the lineage link (which no longer points anywhere meaningful anyway).
--   - PromptTag (many-to-many), PromptComment, PromptCommentReaction,
--     ConversationPrompt, and PromptConnection all have Cascade on promptId.

-- 1. Null out forkedFromId on any ORG/USER forks that point at the
--    SYSTEM rows we're about to delete. Their content is preserved.
UPDATE "prompt"
SET "forkedFromId" = NULL
WHERE "forkedFromId" IN (
  SELECT id FROM "prompt"
  WHERE key IN ('bug_placeholder', 'bug_triage', 'bug_draft')
    AND scope = 'SYSTEM'
);

-- 2. Drop the SYSTEM Prompt rows. PromptVersion + dependent tables cascade.
DELETE FROM "prompt"
WHERE key IN ('bug_placeholder', 'bug_triage', 'bug_draft')
  AND scope = 'SYSTEM';
