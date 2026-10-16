-- Validate the re-run source foreign key added NOT VALID in 20261015150000.
-- The column was added in that migration, so every existing row holds NULL
-- and the scan finds nothing to reject; the constraint already enforces new
-- writes. Bound this scan here: preflight timeouts do not carry into migrate
-- deploy.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE "project_document_analysis"
  VALIDATE CONSTRAINT "project_document_analysis_sourceRunId_fkey";
