-- A paused automatic sync has no next check scheduled. Until now the pause
-- left the poll's expired lease in "nextCheckAt", which read as an overdue
-- check on a row the poll never claims. Additive: existing rows keep their
-- values; only new pause writes store NULL.
ALTER TABLE "project_instruction_repository_sync" ALTER COLUMN "nextCheckAt" DROP NOT NULL;
