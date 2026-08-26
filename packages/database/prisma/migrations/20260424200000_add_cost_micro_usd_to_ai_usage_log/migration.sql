-- Add a higher-precision cost column alongside costCents.
--
-- Rationale: costCents is a rounded Int; any call under $0.005 rounds to 0
-- per row, so summing many sub-cent calls in the per-project usage dashboard
-- displayed $0 even when real spend was non-trivial. costMicroUsd stores
-- micro-USD (1μ$ = $10^-6); Int32 fits up to ~$2147 per row, which is more
-- than any single call.
--
-- costCents is kept unchanged because existing consumers (ai-credits.ts
-- leaderboards, credit aggregates) already depend on it. New readers that
-- need accurate sub-cent accounting should use costMicroUsd; writers
-- populate both so the two stay consistent.

ALTER TABLE "ai_usage_log" ADD COLUMN "costMicroUsd" INTEGER NOT NULL DEFAULT 0;

-- Backfill from the existing rounded-cent column so historical rows don't
-- show as zero in the new dashboard (1 cent = 10_000 μ$). Sub-cent precision
-- for pre-migration rows is lost, but this is the best recovery possible
-- without recomputing from tokens + pricing.
UPDATE "ai_usage_log"
SET "costMicroUsd" = "costCents" * 10000
WHERE "costMicroUsd" = 0 AND "costCents" > 0;
