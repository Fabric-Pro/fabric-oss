-- FR9/10 (incremental): additive nullable angle label on publishing_topic. Backward-compatible; existing rows read back NULL.
ALTER TABLE "publishing_topic" ADD COLUMN "angle" TEXT;
