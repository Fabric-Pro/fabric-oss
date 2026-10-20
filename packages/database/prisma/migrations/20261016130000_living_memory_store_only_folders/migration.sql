-- Living Memory "Store only" write folders (ADR-022).
--
-- Each write folder chooses whether its files are embedded for AI search
-- ("project_context_write_target"."indexMode": INDEXED, today's behaviour, or
-- STORE_ONLY). The rows under a folder carry a derived copy,
-- "project_context"."indexingExcluded", recomputed by the application
-- (`reconcileContextIndexing`) in the transaction of every folder change and
-- every sync apply batch; the awaiting-index scans and the summarization reads
-- skip rows where it is true.
--
-- Both columns are NOT NULL with a constant default, so the ADD COLUMNs are
-- metadata-only (no table rewrite) and every existing row and folder keeps
-- today's behaviour. Nothing is backfilled. Dropping the two columns and the
-- enum undoes the migration. No new RLS: both tables are already registered.

-- CreateEnum
CREATE TYPE "ProjectContextIndexMode" AS ENUM ('INDEXED', 'STORE_ONLY');

-- AlterTable
ALTER TABLE "project_context" ADD COLUMN     "indexingExcluded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "project_context_write_target" ADD COLUMN     "indexMode" "ProjectContextIndexMode" NOT NULL DEFAULT 'INDEXED';
