-- Publishing Suite 1C-1 follow-up: durable audit breadcrumb for manual "Generate now" runs.
-- Nullable, no default — additive, no table rewrite.
ALTER TABLE "publishing_suggestion_cycle" ADD COLUMN "triggeredByUserId" TEXT;
