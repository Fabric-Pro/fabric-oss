-- migration-lint: allow unbatched-backfill — project_rag_settings holds one row per project, so one UPDATE is brief
-- Scheduled code index refresh stays off for projects that existed before it
-- shipped, so the deploy itself starts no checks or re-embedding; a project
-- turns it on from its settings. Rows created from now on keep the DAILY
-- column default.
UPDATE "project_rag_settings" SET "codeIndexRefreshInterval" = 'OFF';
