-- Agent-framework terminology migration: "user story" -> "feature"
--
-- Brings already-seeded SYSTEM rows in line with the updated seed scripts
-- (seed-system-agents.ts, seed-agent-templates.ts) on environments that will
-- not re-run the seeds. Terminology-only: agent keys/ids, skill ids, tags, and
-- document-type enum values are intentionally left untouched.
--
-- Scoped to the exact rows whose seed content changed:
--   registered_agent: story_breakdown, backlog_updater, project_document_generator
--   agent_template:   prd-writer
--
-- Every statement is idempotent: replace() of an already-converted phrase is a
-- no-op, so re-running the migration changes nothing.

-- registered_agent.description (story_breakdown, backlog_updater)
UPDATE "registered_agent"
SET "description" = replace("description", 'user stories', 'features')
WHERE "agentId" IN ('story_breakdown', 'backlog_updater')
  AND "description" IS NOT NULL;

-- registered_agent.metadata skills text (story_breakdown, backlog_updater)
-- Handles "Create User Stories" -> "Create Features" and
-- "...user stories..." -> "...features..." inside the skills JSON.
UPDATE "registered_agent"
SET "metadata" = replace(
  replace("metadata"::text, 'User Stories', 'Features'),
  'user stories',
  'features'
)::jsonb
WHERE "agentId" IN ('story_breakdown', 'backlog_updater')
  AND "metadata" IS NOT NULL;

-- registered_agent.metadata for project_document_generator: the generate_prd
-- skill already lists "features", so drop the redundant "user stories" rather
-- than duplicating it.
UPDATE "registered_agent"
SET "metadata" = replace(
  "metadata"::text,
  'features, user stories, and acceptance criteria',
  'features and acceptance criteria'
)::jsonb
WHERE "agentId" = 'project_document_generator'
  AND "metadata" IS NOT NULL;

-- agent_template.description (prd-writer)
UPDATE "agent_template"
SET "description" = replace("description", 'user stories', 'features')
WHERE "slug" = 'prd-writer';

-- agent_template.instructions (prd-writer): process step + PRD structure line.
UPDATE "agent_template"
SET "instructions" = replace(
  replace("instructions", 'User Stories', 'Features'),
  'user stories',
  'features'
)
WHERE "slug" = 'prd-writer'
  AND "instructions" IS NOT NULL;
