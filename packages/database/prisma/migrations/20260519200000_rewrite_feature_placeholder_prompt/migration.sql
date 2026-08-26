-- Spec follow-up: 2026-05-19-remove-passive-analysis (REQ-10 / AC10).
--
-- The original spec PR (#1055) rewrote two lines of the `feature_placeholder`
-- system prompt in `seed-prompts-only.ts` so the LLM no longer sees
-- "PASSIVE_ANALYSIS → ACTIVE_ANALYSIS → SANITY_CHECK → DRAFT" in its template
-- body and description. The rewrite lands in `Prompt` and `PromptVersion` rows
-- only for fresh installs, because `seed-prompts-only.ts` enforces an
-- insert-only contract for system prompts (line 2500: "never mutate an
-- existing SYSTEM prompt's versions or cascade bindings on rerun").
--
-- On any environment that was seeded BEFORE the source-file rewrite (every
-- prod and staging environment as of 2026-05-19), the live Prompt row still
-- contains the deprecated stage chain in both the `description` column and
-- the latest `PromptVersion.content` column. The runtime Enhance flow loads
-- that body and feeds it to the LLM, so the AI keeps echoing PASSIVE_ANALYSIS
-- in placeholder-stage outputs even though the workflow stage itself is
-- gone. REQ-10 / AC10 is therefore not satisfied at runtime without this
-- migration.
--
-- This migration patches the existing rows in place by replacing the exact
-- substring. It is idempotent (the LIKE filters skip rows that no longer
-- contain the deprecated text) and touches only the SYSTEM-scoped
-- feature_placeholder prompt. Forked org/user copies (scope = 'ORG' / 'USER')
-- are untouched — those are user-owned artefacts.

UPDATE "prompt"
SET description = REPLACE(
  description,
  'PASSIVE_ANALYSIS → ACTIVE_ANALYSIS → SANITY_CHECK → DRAFT',
  'Active Analysis → Sanity Check → Draft'
)
WHERE key = 'feature_placeholder'
  AND scope = 'SYSTEM'
  AND description LIKE '%PASSIVE_ANALYSIS → ACTIVE_ANALYSIS%';

UPDATE "prompt_version" pv
SET content = REPLACE(
  pv.content,
  'PASSIVE_ANALYSIS → ACTIVE_ANALYSIS → SANITY_CHECK → DRAFT',
  'Active Analysis → Sanity Check → Draft'
)
FROM "prompt" p
WHERE pv."promptId" = p.id
  AND p.key = 'feature_placeholder'
  AND p.scope = 'SYSTEM'
  AND pv.content LIKE '%PASSIVE_ANALYSIS → ACTIVE_ANALYSIS%';

-- =====================================================================
-- ROLLBACK (manual, only if needed)
-- =====================================================================
-- The inverse REPLACE restores the deprecated chain to any row this
-- migration touched. Apply only if the spec is reverted; otherwise the
-- LLM keeps emitting the deprecated stage name in new placeholder outputs.
--
--   UPDATE "prompt"
--   SET description = REPLACE(
--     description,
--     'Active Analysis → Sanity Check → Draft',
--     'PASSIVE_ANALYSIS → ACTIVE_ANALYSIS → SANITY_CHECK → DRAFT'
--   )
--   WHERE key = 'feature_placeholder'
--     AND scope = 'SYSTEM'
--     AND description LIKE '%(Active Analysis → Sanity Check → Draft)%';
--
--   UPDATE "prompt_version" pv
--   SET content = REPLACE(
--     pv.content,
--     'Active Analysis → Sanity Check → Draft',
--     'PASSIVE_ANALYSIS → ACTIVE_ANALYSIS → SANITY_CHECK → DRAFT'
--   )
--   FROM "prompt" p
--   WHERE pv."promptId" = p.id
--     AND p.key = 'feature_placeholder'
--     AND p.scope = 'SYSTEM'
--     AND pv.content LIKE '%through Active Analysis → Sanity Check → Draft%';
