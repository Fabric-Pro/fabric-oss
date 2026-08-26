-- Keeping a test case honest as its feature changes (spec §7.1 step 6).
--
-- A case drafted from an acceptance criterion goes stale the moment that
-- criterion is rewritten, and nothing said so — the suite kept asserting a flow
-- the product no longer had, which is worse than no coverage because it reads
-- AS coverage.
--
-- `draftedFromSpecHash` is a hash of the feature text the case came from, not a
-- timestamp: a feature saved twice with no textual change must not make every
-- case it covers look stale, or the signal becomes noise people dismiss. NULL
-- for hand-authored cases, which were never derived from the text.
--
-- The proposal lives on the case because there is at most one outstanding per
-- case and it is meaningless without it. All three columns are nullable, so
-- every existing row is unaffected and nothing changes until a case is actually
-- re-drafted.
ALTER TABLE "test_case"
  ADD COLUMN "draftedFromSpecHash" TEXT,
  ADD COLUMN "proposedSteps" JSONB,
  ADD COLUMN "proposedAt" TIMESTAMP(3);
