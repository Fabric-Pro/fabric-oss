-- PM custom-field read mapping: project-level feature flag gating
-- the new Project Management field-mapping tab, picker, and replace-mode aggregation.
--
-- Additive + backward-compatible: single boolean column with a default, so existing
-- rows are unaffected (flag off = today's behavior). `migrate deploy` applies this
-- cleanly on staging/prod with no destructive ops.

-- AlterTable
ALTER TABLE "project" ADD COLUMN "pmFieldMappingEnabled" BOOLEAN NOT NULL DEFAULT false;
