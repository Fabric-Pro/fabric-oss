-- Per-user roadmap view preferences (layout, grouping, sort, card fields + order)
-- and per-user manual story ordering ({ storyId: order } map). Stored as JSON so
-- the shape can evolve without further migrations; the web client sanitizes on read.
ALTER TABLE "project_user_preference" ADD COLUMN "roadmapView" JSONB;
ALTER TABLE "project_user_preference" ADD COLUMN "roadmapStoryOrder" JSONB;
