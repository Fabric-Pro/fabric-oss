-- Add ProjectContext.urlActiveWorkflowId — Temporal workflowId of the
-- in-flight crawl, NULL when none. Used by `cancelUrlSourceCrawl` to look
-- up the workflow and propagate cancellation. Cleared by
-- `updateParentStatusActivity` when the workflow finalizes.
--
-- Safe to run on production: additive nullable column with no default and
-- no data backfill required. No locks beyond a brief table-level metadata
-- update.

ALTER TABLE "project_context" ADD COLUMN "urlActiveWorkflowId" TEXT;
