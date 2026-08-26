-- What to do about a finding, kept apart from what is wrong with it.
--
-- Nullable: the rows written before this column existed have no recommendation,
-- and backfilling one would mean inventing advice nobody gave. Every write since
-- carries one — the QA lens drops a finding whose recommendation is empty, and
-- the architecture lens composes its own from the violation it proved.
ALTER TABLE "pull_request_review_finding" ADD COLUMN "recommendation" TEXT;
