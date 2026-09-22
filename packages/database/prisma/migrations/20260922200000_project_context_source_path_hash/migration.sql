-- Synced knowledge files (Fizzy #2616): a text file an MCP client or the CLI
-- pushes into a project's Context by its relative path.
--
-- `sourcePath` + `projectId` key the row, so pushing the same file again
-- updates it instead of adding a duplicate. `contentHash` (sha256 hex of the
-- UTF-8 content) makes an unchanged push a no-op and is the compare-and-swap
-- token a replace must present. `contentUpdatedAt` / `contentUpdatedByUserId`
-- let a conflict name who last changed the file; they are stamped only by the
-- synced-file path, never by the metadata edit's own pair.
--
-- All nullable with no default and no backfill: no existing row came through
-- that path, and a nullable add does not rewrite the table. Same table as
-- before, so the existing RLS policies (organizationId / userId) already cover
-- it. The two indexes each get a migration of their own below, CONCURRENTLY.
-- AlterTable
ALTER TABLE "project_context" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "contentUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "contentUpdatedByUserId" TEXT,
ADD COLUMN     "sourcePath" TEXT;
