-- Recording what a step proposal was checked against.
--
-- Revising a test case has had exactly one meaning: re-read the feature's
-- acceptance criteria and propose steps that match them. Accepting such a
-- proposal stamps `draftedFromSpecHash`, which is correct — the case now agrees
-- with the spec, so it is no longer drifted from it.
--
-- A second revision path reads the pull request that implemented the feature and
-- proposes steps that match what was actually built. Accepting one of those must
-- NOT stamp the hash. The revision never looked at the spec, and a case can
-- honestly be both revised-from-implementation and still spec-drifted; stamping
-- would clear a flag nothing checked and hide real drift until the next edit.
--
-- The distinction lives on the row rather than in the caller because the accept
-- path is one procedure serving both. A caller-supplied "should I stamp" flag
-- would be a rule the UI has to remember, and the one place it is forgotten is
-- the place the drift silently disappears.
--
-- Nullable and additive: no existing row changes. Every proposal outstanding when
-- this ships was spec-derived, and NULL is what the accept path reads as SPEC —
-- so pending proposals keep stamping exactly as they did before.
CREATE TYPE "test_case_proposal_source" AS ENUM ('SPEC', 'IMPLEMENTATION');

ALTER TABLE "test_case"
  ADD COLUMN "proposedFrom" "test_case_proposal_source";
