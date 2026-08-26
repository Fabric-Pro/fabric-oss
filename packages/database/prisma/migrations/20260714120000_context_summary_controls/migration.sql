-- Context Summary user controls: cancellable runs, per-source selection remembered
-- per history entry, manual-edit provenance, and real per-run token spend.
--
-- Additive + backward-compatible: every new column is nullable (or defaults), and a
-- null "sourceSelection" on an existing row means "all sources" so prior summaries
-- are unaffected. "manualEdit" defaults false. The CANCELLED status only ever applies
-- to a run a user cancels; existing rows keep their status.

-- Add the CANCELLED terminal status for user-cancelled runs.
ALTER TYPE "context_summary_status" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- AlterTable
ALTER TABLE "project_context_summary"
    ADD COLUMN "sourceSelection" JSONB,
    ADD COLUMN "manualEdit" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "editedByUserId" TEXT,
    ADD COLUMN "spentInputTokens" INTEGER,
    ADD COLUMN "spentOutputTokens" INTEGER,
    ADD COLUMN "spentCostMicroUsd" BIGINT;
