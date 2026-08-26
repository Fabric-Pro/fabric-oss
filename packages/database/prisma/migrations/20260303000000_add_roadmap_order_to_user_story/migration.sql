-- AlterTable: add roadmapOrder for Roadmap-specific ordering (distinct from Kanban `order`)
ALTER TABLE "user_story" ADD COLUMN IF NOT EXISTS "roadmapOrder" DOUBLE PRECISION NOT NULL DEFAULT 0;
