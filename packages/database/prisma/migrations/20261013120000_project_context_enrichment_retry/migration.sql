-- Rows whose chunks were embedded without contextual enrichment because the
-- ChatGPT plan was spent, and the earliest time a re-embed may retry (Fizzy #2770).
-- Nullable, no default, no index: a metadata-only change on an existing table.
ALTER TABLE "project_context" ADD COLUMN "contextEnrichmentRetryAt" TIMESTAMP(3);
