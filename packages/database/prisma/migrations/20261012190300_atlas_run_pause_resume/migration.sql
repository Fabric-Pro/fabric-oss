-- An Atlas analysis run pauses for a ChatGPT plan reset and resumes later:
-- the workflow that holds the run (its scheduled or approved resume), when
-- the resume starts, the pause count and first pause (the cap), the saved
-- progress, and the per-run "Run now on API billing" override. Nullable or
-- defaulted only.
ALTER TABLE "atlas_analysis_run" ADD COLUMN IF NOT EXISTS "workflowId" TEXT,
    ADD COLUMN IF NOT EXISTS "resumesAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "pauseCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "firstPausedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "resumeState" JSONB,
    ADD COLUMN IF NOT EXISTS "apiOverrideAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "apiOverrideByUserId" TEXT;
