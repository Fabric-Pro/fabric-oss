-- Who last edited a context source's type label / AI instructions, and when.
--
-- Stamped by every metadata write — the Context tab's source-details dialog
-- and the `fabric_update_project_context` MCP tool — and shown in that dialog.
-- `updatedAt` cannot answer the question: re-crawls and embedding bump it too.
--
-- Both nullable with no default and no backfill: a row nobody has edited since
-- this landed simply has no answer, and a nullable add does not rewrite the
-- table. Same table as before, so the existing RLS policies already cover it.
-- AlterTable
ALTER TABLE "project_context" ADD COLUMN     "metadataUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "metadataUpdatedByUserId" TEXT;
