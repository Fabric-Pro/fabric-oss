-- F-171 alignment: drop the 3-stage bug pipeline (TRIAGE) introduced by
-- PR #903 and adopt the single-stage bug workflow + needsMoreInfo flag +
-- reporter tracking per the F-171 spec (approved 5/12).
--
-- Migration order matters:
--   1. Defensively snap any UserStory/FeatureVersion rows in TRIAGE to DRAFT.
--      Pre-flight should confirm 0 rows; this is a safety net.
--   2. Delete PromptBinding rows that reference the deprecated bug stage
--      prompts (bug_placeholder/bug_triage/bug_draft) or that have a stale
--      documentType of "TRIAGE". The underlying Prompt rows are left in
--      place — they become deprecated SYSTEM prompts with no active binding
--      and won't resolve at runtime. We don't destroy user data; PMs who
--      may have forked these to USER/ORG scope keep their forks intact.
--   3. Recreate FeatureDraftingStage without TRIAGE. Postgres has no
--      DROP VALUE for enums, so we rename → create the slim enum → alter
--      every column → drop the renamed old enum. Defaults are restated.
--   4. Add the ReporterSource enum.
--   5. Add needsMoreInfo + reporter tracking columns to UserStory.
--   6. Partial index on needsMoreInfo for the roadmap "Needs More Info"
--      filter — most rows are unflagged, so partial is meaningfully smaller.

-- 1. Snap any stragglers in TRIAGE back to DRAFT before dropping the value.
-- FeatureDraftingStage is used on four tables: user_story, feature_version,
-- epic, feature. Only user_story is bug-bearing, but we sweep all four for
-- safety so the enum drop cannot fail on lingering data.
UPDATE "user_story" SET "draftingStage" = 'DRAFT' WHERE "draftingStage" = 'TRIAGE';
UPDATE "feature_version" SET "draftingStage" = 'DRAFT' WHERE "draftingStage" = 'TRIAGE';
UPDATE "epic" SET "draftingStage" = 'DRAFT' WHERE "draftingStage" = 'TRIAGE';
UPDATE "feature" SET "draftingStage" = 'DRAFT' WHERE "draftingStage" = 'TRIAGE';

-- 2. Delete deprecated bug-stage PromptBindings.
DELETE FROM "prompt_binding"
WHERE "promptVersionId" IN (
  SELECT pv.id FROM "prompt_version" pv
  JOIN "prompt" p ON p.id = pv."promptId"
  WHERE p.key IN ('bug_placeholder', 'bug_triage', 'bug_draft')
    AND p.scope = 'SYSTEM'
);
DELETE FROM "prompt_binding" WHERE "documentType" = 'TRIAGE';

-- 3. Recreate FeatureDraftingStage without TRIAGE.
ALTER TYPE "FeatureDraftingStage" RENAME TO "FeatureDraftingStage_old";

CREATE TYPE "FeatureDraftingStage" AS ENUM (
  'PLACEHOLDER',
  'PASSIVE_ANALYSIS',
  'ACTIVE_ANALYSIS',
  'SANITY_CHECK',
  'DRAFT',
  'PUBLISHED',
  'DECLINED',
  'CLOSED'
);

ALTER TABLE "user_story" ALTER COLUMN "draftingStage" DROP DEFAULT;
ALTER TABLE "user_story"
  ALTER COLUMN "draftingStage" TYPE "FeatureDraftingStage"
  USING "draftingStage"::text::"FeatureDraftingStage";
ALTER TABLE "user_story" ALTER COLUMN "draftingStage" SET DEFAULT 'PLACEHOLDER';

ALTER TABLE "feature_version"
  ALTER COLUMN "draftingStage" TYPE "FeatureDraftingStage"
  USING "draftingStage"::text::"FeatureDraftingStage";

ALTER TABLE "epic" ALTER COLUMN "draftingStage" DROP DEFAULT;
ALTER TABLE "epic"
  ALTER COLUMN "draftingStage" TYPE "FeatureDraftingStage"
  USING "draftingStage"::text::"FeatureDraftingStage";
ALTER TABLE "epic" ALTER COLUMN "draftingStage" SET DEFAULT 'PUBLISHED';

ALTER TABLE "feature" ALTER COLUMN "draftingStage" DROP DEFAULT;
ALTER TABLE "feature"
  ALTER COLUMN "draftingStage" TYPE "FeatureDraftingStage"
  USING "draftingStage"::text::"FeatureDraftingStage";
ALTER TABLE "feature" ALTER COLUMN "draftingStage" SET DEFAULT 'PUBLISHED';

DROP TYPE "FeatureDraftingStage_old";

-- 4. ReporterSource enum (REQ-20).
CREATE TYPE "ReporterSource" AS ENUM ('SLACK', 'TEAMS', 'MANUAL');

-- 5. UserStory: needsMoreInfo flag + reporter tracking (REQ-19, REQ-20).
ALTER TABLE "user_story" ADD COLUMN "needsMoreInfo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_story" ADD COLUMN "reporterName" TEXT;
ALTER TABLE "user_story" ADD COLUMN "reporterSource" "ReporterSource";
ALTER TABLE "user_story" ADD COLUMN "reporterSourceUrl" TEXT;

-- 6. No explicit index on needsMoreInfo for now. The roadmap filter joins
-- by projectId first (covered by the existing user_story_projectId_idx),
-- which gives an acceptable plan when combined with the needsMoreInfo
-- predicate. We can add a partial index in a follow-up if profiling shows
-- the filter is hot enough to warrant it — keeping Prisma's @@index map in
-- sync with hand-authored partial indexes is fiddly, so defer until needed.
