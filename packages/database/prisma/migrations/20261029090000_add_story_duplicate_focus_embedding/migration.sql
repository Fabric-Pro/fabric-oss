-- Embedding cache for the Scope / acceptance-criteria sections of features.
--
-- A feature pair is now a duplicate candidate when its Scope-weighted score
-- clears the threshold, not only its whole-document cosine. That needs every
-- feature's section vectors on every scan, so they are cached here instead of
-- being re-embedded each run — the same reason `story_duplicate_embedding`
-- exists for whole documents.
--
-- One row per story and section kind ("scope" / "acceptance_criteria"),
-- invalidated by a section-text hash or embedding-model change.
--
-- No backfill: an absent row reads as stale and is embedded on the next scan.
CREATE TABLE "story_duplicate_focus_embedding" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_duplicate_focus_embedding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "story_duplicate_focus_embedding_projectId_idx" ON "story_duplicate_focus_embedding"("projectId");

CREATE UNIQUE INDEX "story_duplicate_focus_embedding_storyId_kind_key" ON "story_duplicate_focus_embedding"("storyId", "kind");

ALTER TABLE "story_duplicate_focus_embedding" ADD CONSTRAINT "story_duplicate_focus_embedding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "story_duplicate_focus_embedding" ADD CONSTRAINT "story_duplicate_focus_embedding_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
