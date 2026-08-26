-- Retire the `priority_ranking_insights` prompt: the insights surface it drove
-- was removed (its rationale now comes from real priority changes), and the
-- seed is insert-only by design — so without this, already-seeded environments
-- keep a dead SYSTEM prompt that admins can edit to no effect (repo rule:
-- seed retirements ship as a migration).
--
-- Deliberately NOT touched: `priority_reprioritization` — the live prompt that
-- assigns bands AND writes the per-change rationale — and any ORG/USER-scoped
-- prompt (an org's fork of the old insights prompt stays theirs; only its
-- binding to the dead agent target goes).
--
-- FK safety: prompt -> prompt_version is CASCADE, prompt_version ->
-- prompt_binding is CASCADE, and document_version.promptVersionId is SET NULL,
-- so the single prompt DELETE cleans its versions/bindings without orphaning
-- or blocking on anything.

-- 1. Bindings pointing at the dead agent target, whatever prompt they bind
--    (covers org-created bindings whose prompts we keep).
DELETE FROM "prompt_binding" WHERE "targetKey" = 'priority_ranking_insights';

-- 2. The seeded SYSTEM prompt itself (cascades its versions).
DELETE FROM "prompt"
WHERE "key" = 'priority_ranking_insights' AND "scope" = 'SYSTEM';
