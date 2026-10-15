-- Validate the Living Memory foreign key added NOT VALID in
-- 20260923150000_context_repository_sync, which shipped in an earlier
-- release. Every row that existed then kept "repositorySyncId" NULL, and the
-- foreign key already enforces every write since, so this scan checks only
-- the rows the sync wrote. VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and
-- writes on "project_context" continue while it runs.
-- Bound this scan here: preflight timeouts do not carry into migrate deploy.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE "project_context"
  VALIDATE CONSTRAINT "project_context_repositorySyncId_fkey";
