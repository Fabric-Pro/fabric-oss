-- Living Documents auto-refresh — a refresh proposes by default; applying is opt-in.
--
-- Schema delta:
--   * document_auto_refresh_settings.autoApply (BOOLEAN, default false) — when
--     false, a refresh does NOT write to the document. It stores its result as a
--     proposal (the four `pending*` columns) and notifies; a human accepts or
--     rejects. Turning it on is the "AI commits directly" behavior, kept as a
--     deliberate per-document opt-in rather than the default.
--   * pendingContent / pendingSummary / pendingProposedAt / pendingBaselineVersion —
--     the proposal. `pendingBaselineVersion` is the document version the proposal
--     was generated from; accepting re-runs the same optimistic-concurrency check,
--     so a proposal overtaken by a human edit cannot be applied blind.
--
-- Additive and backward-compatible: existing rows default to autoApply=false with
-- no pending proposal, which is the safe state.

-- AlterTable
ALTER TABLE "document_auto_refresh_settings"
    ADD COLUMN "autoApply" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "pendingContent" TEXT,
    ADD COLUMN "pendingSummary" TEXT,
    ADD COLUMN "pendingProposedAt" TIMESTAMP(3),
    ADD COLUMN "pendingBaselineVersion" INTEGER;
