-- Embedding cache for Create-vs-Enrich action-item routing.
--
-- Mirrors `story_duplicate_embedding` deliberately: same shape, same staleness
-- contract (content hash + embedding model), same one-row-per-story key.
--
-- It cannot REUSE that table. Duplicate detection embeds `buildDetectionText`
-- (title + 1,000 chars of description); routing embeds `buildRoutingText`
-- (title + description + acceptance criteria, 6,000 chars). Different text
-- produces a different vector, and the sibling table is unique on `storyId`, so
-- sharing it would silently hand one feature the other's vectors.
--
-- Why a cache at all: without it the routing pass re-embeds every active ticket
-- in the project on EVERY ingestion run. That is the exact shape that took down
-- the duplicate scan at ~350 tickets (a five-minute gateway timeout), which is
-- why that pass grew this cache. Routing runs far more often — once per
-- transcript and once per monitored thread — so it needed the same treatment
-- before a large backlog hit it.
--
-- No backfill: an absent row simply reads as stale and is embedded once on the
-- next run.
CREATE TABLE "story_routing_embedding" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_routing_embedding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "story_routing_embedding_storyId_key" ON "story_routing_embedding"("storyId");

CREATE INDEX "story_routing_embedding_projectId_idx" ON "story_routing_embedding"("projectId");

ALTER TABLE "story_routing_embedding" ADD CONSTRAINT "story_routing_embedding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "story_routing_embedding" ADD CONSTRAINT "story_routing_embedding_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
