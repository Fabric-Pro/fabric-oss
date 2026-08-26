ALTER TABLE "coding_run"
ADD COLUMN "weave_execution_id" TEXT;

CREATE INDEX IF NOT EXISTS "coding_run_weave_execution_id_idx"
ON "coding_run"("weave_execution_id");
