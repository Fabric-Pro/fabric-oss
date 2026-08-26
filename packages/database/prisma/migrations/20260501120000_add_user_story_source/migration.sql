-- CreateEnum
CREATE TYPE "StorySource" AS ENUM ('MANUAL', 'JIRA', 'AZURE_DEVOPS', 'FIZZY', 'GITLAB', 'LINEAR', 'GITHUB', 'AI_UPDATE', 'APPROVED_PROPOSAL');

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN "source" "StorySource" NOT NULL DEFAULT 'MANUAL';

-- Backfill existing rows from the same heuristic the FE used before this column existed.
-- Precedence (mirrors deriveStorySource in apps/web/modules/saas/projects/lib/roadmap-filters.ts):
--   1. labels include 'approved-proposal'   -> APPROVED_PROPOSAL
--   2. pipelineExecutionId set              -> AI_UPDATE
--   3. externalUrl host matches PM tool     -> JIRA / AZURE_DEVOPS / FIZZY / GITLAB / LINEAR / GITHUB
--   4. otherwise                            -> MANUAL (already set by DEFAULT)
--
-- Host extraction: substring(... from '^https?://([^/]+)') pulls just the host
-- so a URL like https://example.com/?ref=visualstudio.com cannot be
-- misclassified by a substring match against the full URL.
UPDATE "user_story" SET "source" = CASE
  WHEN 'approved-proposal' = ANY("labels")              THEN 'APPROVED_PROPOSAL'::"StorySource"
  WHEN "pipelineExecutionId" IS NOT NULL                THEN 'AI_UPDATE'::"StorySource"
  WHEN substring("externalUrl" from '^https?://([^/]+)') ~* '(^|\.)atlassian\.net$|(^|\.)jira\.com$'
                                                         THEN 'JIRA'::"StorySource"
  WHEN substring("externalUrl" from '^https?://([^/]+)') ~* '^dev\.azure\.com$|(^|\.)visualstudio\.com$'
                                                         THEN 'AZURE_DEVOPS'::"StorySource"
  WHEN substring("externalUrl" from '^https?://([^/]+)') ~* '(^|\.)fizzy\.do$'
                                                         THEN 'FIZZY'::"StorySource"
  WHEN substring("externalUrl" from '^https?://([^/]+)') ~* '(^|\.)gitlab\.com$'
                                                         THEN 'GITLAB'::"StorySource"
  WHEN substring("externalUrl" from '^https?://([^/]+)') ~* '(^|\.)linear\.app$'
                                                         THEN 'LINEAR'::"StorySource"
  WHEN substring("externalUrl" from '^https?://([^/]+)') ~* '(^|\.)github\.com$'
                                                         THEN 'GITHUB'::"StorySource"
  ELSE 'MANUAL'::"StorySource"
END
WHERE "source" = 'MANUAL';

-- CreateIndex
CREATE INDEX "user_story_projectId_source_idx" ON "user_story"("projectId", "source");
