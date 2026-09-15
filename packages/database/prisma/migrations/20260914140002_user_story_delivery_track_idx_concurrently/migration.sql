-- Inverted loop (Slice 2): roadmap lane grouping by delivery track. Built
-- CONCURRENTLY in its own migration so "user_story" is not write-locked.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_story_projectId_deliveryTrack_idx" ON "user_story"("projectId", "deliveryTrack");
