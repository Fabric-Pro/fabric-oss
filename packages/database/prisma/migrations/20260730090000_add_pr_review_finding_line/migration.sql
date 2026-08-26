-- The line a PR-review finding concerns, when the model claimed one AND it was
-- verified against the diff hunks (card 1642 AC4 asks for file AND line).
--
-- Nullable and unverified-becomes-null on purpose: a line a model invented sends
-- a reader to the wrong place and looks authoritative doing it.
ALTER TABLE "pull_request_review_finding" ADD COLUMN "line" INTEGER;
