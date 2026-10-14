-- Bulk runs pause for a ChatGPT plan reset and resume later: when the resume
-- starts, the pause count and first pause (the cap), the saved progress, and
-- the per-run "Run now on API billing" override. Nullable or defaulted only.
ALTER TABLE "project_scan" ADD COLUMN IF NOT EXISTS "resumesAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "pauseCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "firstPausedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "resumeState" JSONB,
    ADD COLUMN IF NOT EXISTS "apiOverrideAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "apiOverrideByUserId" TEXT;

ALTER TABLE "scan_finding_review" ADD COLUMN IF NOT EXISTS "resumesAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "pauseCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "firstPausedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "resumeState" JSONB,
    ADD COLUMN IF NOT EXISTS "apiOverrideAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "apiOverrideByUserId" TEXT;

ALTER TABLE "scan_finding_grouping" ADD COLUMN IF NOT EXISTS "resumesAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "pauseCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "firstPausedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "resumeState" JSONB,
    ADD COLUMN IF NOT EXISTS "apiOverrideAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "apiOverrideByUserId" TEXT;

ALTER TABLE "agent_task" ADD COLUMN IF NOT EXISTS "resumesAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "pauseCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "firstPausedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "resumeState" JSONB,
    ADD COLUMN IF NOT EXISTS "apiOverrideAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "apiOverrideByUserId" TEXT;
