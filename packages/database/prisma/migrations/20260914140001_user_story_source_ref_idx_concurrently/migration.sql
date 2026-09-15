-- Inverted loop (plan §F3): scope-intake provenance lookup. Built CONCURRENTLY in
-- its own migration so "user_story" is not write-locked for the build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_story_projectId_sourceRef_idx" ON "user_story"("projectId", "sourceRef");
