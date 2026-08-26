-- Bug lifecycle support: adds TRIAGE to FeatureDraftingStage (bugs use
-- PLACEHOLDER, TRIAGE, DRAFT — the first and last are shared with features),
-- and adds a nullable storyKind column to PromptBinding so stage prompts can
-- be scoped per StoryKind without crosstalk between feature and bug pipelines.

-- AlterEnum: add TRIAGE stage (used only when UserStory.kind = BUG).
ALTER TYPE "FeatureDraftingStage" ADD VALUE 'TRIAGE';

-- AlterTable: add nullable storyKind to PromptBinding.
-- NULL = "any kind" (non-stage bindings like PRD/PROPOSAL).
-- FEATURE/BUG/USER_STORY = stage binding scoped to that kind.
ALTER TABLE "prompt_binding" ADD COLUMN "storyKind" "StoryKind";

-- Backfill: existing project_document_generator bindings for feature drafting
-- stages were implicitly for FEATURE — make that explicit so lookups with
-- storyKind='FEATURE' continue to find them.
UPDATE "prompt_binding"
SET "storyKind" = 'FEATURE'
WHERE "targetKey" = 'project_document_generator'
  AND "documentType" IN ('PLACEHOLDER', 'PASSIVE_ANALYSIS', 'ACTIVE_ANALYSIS', 'SANITY_CHECK', 'DRAFT');

-- Replace the old unique constraint with one that includes storyKind.
DROP INDEX "public"."prompt_binding_targetType_targetKey_documentType_scope_user_key";

CREATE UNIQUE INDEX "prompt_binding_targetType_targetKey_documentType_storyKind__key" ON "prompt_binding"("targetType", "targetKey", "documentType", "storyKind", "scope", "userId", "organizationId");

-- Compound index used by stage-prompt lookups (target + docType + storyKind).
CREATE INDEX "prompt_binding_targetType_targetKey_documentType_storyKind_idx" ON "prompt_binding"("targetType", "targetKey", "documentType", "storyKind");
