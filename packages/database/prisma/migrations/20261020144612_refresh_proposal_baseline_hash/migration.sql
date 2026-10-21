-- Living Documents auto-refresh — a stored proposal remembers the body it was
-- drafted from (Fizzy #2946).
--
-- Schema delta:
--   * document_auto_refresh_settings.pendingBaselineContentHash (TEXT, nullable) —
--     `contentIdentity` of the body the model read, beside
--     `pendingBaselineVersion`. Accepting the proposal checks both, because the
--     version alone does not name a body: a Proposal run's final save writes its
--     body at the old version.
--
-- Additive and backward-compatible: existing rows read NULL, and a proposal
-- with no recorded hash keeps the version-only check it had before.

-- AlterTable
ALTER TABLE "document_auto_refresh_settings" ADD COLUMN     "pendingBaselineContentHash" TEXT;
