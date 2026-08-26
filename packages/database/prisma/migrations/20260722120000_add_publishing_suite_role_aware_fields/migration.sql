-- AlterTable: role-aware personalization (1B remainder). FunctionTag enum already
-- exists; no CREATE TYPE. Additive, NOT NULL DEFAULT, rollback-safe,
-- no backfill (old rows keep the empty default; manual rows are already empty).
ALTER TABLE "publishing_topic"
  ADD COLUMN "relevantFunctionTags" "FunctionTag"[] NOT NULL DEFAULT ARRAY[]::"FunctionTag"[],
  ADD COLUMN "postTypeRecommendations" JSONB NOT NULL DEFAULT '[]'::jsonb;
