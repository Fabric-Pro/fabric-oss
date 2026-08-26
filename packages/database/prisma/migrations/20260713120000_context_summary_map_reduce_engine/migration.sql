-- Map-reduce context-summarization engine: whole-history coverage, a true
-- watermark, source-level references, observability/resume stats, and an engine
-- version so legacy (v1) summaries can be trusted-gated and rebuilt.
--
-- Additive + backward-compatible: all new columns are nullable except
-- "engineVersion", which defaults to 1 so every EXISTING summary is flagged
-- legacy (untrustworthy watermark) and gets rebuilt by the cron. New rows are
-- written with engineVersion = 2 by the map-reduce engine.

-- AlterTable
ALTER TABLE "project_context_summary"
    ADD COLUMN "snapshotThrough" TIMESTAMP(3),
    ADD COLUMN "references" JSONB,
    ADD COLUMN "engineVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "stats" JSONB;
