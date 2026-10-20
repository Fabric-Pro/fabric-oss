-- Proposal Internal Analysis: the analysis report beside the findings
-- (Fizzy #2946). `report` holds the structured fields and the source numbers
-- the report text cites; `reportText` holds the full report text as the model
-- wrote it. Both are written by the run's completion and read only by the
-- member-only analysis read.
--
-- Additive and nullable: no rewrite, no default, no index and no backfill.
-- Runs written before this migration, and runs whose prompt asks for no
-- report, keep both columns null and read as "no report". The previous app
-- version neither reads nor writes them. The table is already org-only in the
-- tenant client and RLS, so no policy changes. Deploy order stays migration,
-- then the Temporal worker, then the web.
--
-- lock_timeout FIRST, per the convention in this directory: the timeout has to
-- be in force BEFORE the statement that takes the lock, or it guards nothing.
-- SET LOCAL applies because this file has two statements, and Prisma wraps a
-- multi-statement migration in one transaction.
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "project_document_analysis" ADD COLUMN     "report" JSONB,
ADD COLUMN     "reportText" TEXT;
