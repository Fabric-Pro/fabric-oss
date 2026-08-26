-- Project-tab customization (per-project admin visibility overrides and
-- per-user visibility/ordering preferences). Stored as JSON so the shape can
-- evolve without further migrations; the web client sanitizes unknown tab ids
-- on read. See packages/database/src/project-tabs.ts for the shared contract.
ALTER TABLE "project" ADD COLUMN "projectTabConfig" JSONB;
ALTER TABLE "project_user_preference" ADD COLUMN "projectTabPrefs" JSONB;
