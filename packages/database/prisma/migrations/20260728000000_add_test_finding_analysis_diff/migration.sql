-- The diff the failure analysis reasoned over.
--
-- Nullable with no default: an existing finding was analysed before the diff was
-- retained, and NULL is the honest record of that — "no diff is shown" rather
-- than an empty list, which would read as "we looked and nothing had changed".
ALTER TABLE "test_finding" ADD COLUMN "analysisDiff" JSONB;
