-- Spec §7.2 — the AI failure analysis: let a model propose a CAUSE, not just
-- carry CI's assertion forward.
--
-- What shipped in the RCA path so far is failure *reporting*: a fixed template
-- containing the test name, the branch and commit, and the assertion CI printed.
-- Useful, and not what card 1688 asks for. These columns hold the missing half —
-- a proposed cause and the kind of failure it looks like.
--
-- ADVISORY ONLY. The analysis enriches a finding so a human triaging it starts
-- from a hypothesis rather than a stack trace; it never files anything. Promotion
-- to a bug stays a person's action (product ruling, 2026-07-26). `suspectedKind`
-- in particular must not become an auto-file trigger: a coarse guess is a fine
-- thing to show a human and a terrible thing to act on unattended.
--
-- All columns nullable with no default: a finding recorded before this migration,
-- or one nobody has asked to analyse, is legitimately un-analysed. `analysedAt`
-- being null is what the UI reads as "not analysed yet" — distinct from an
-- analysis that ran and concluded UNKNOWN, which is a real answer.

CREATE TYPE "test_failure_kind" AS ENUM (
    'PRODUCT_BUG',
    'TEST_DEFECT',
    'ENVIRONMENT',
    'FLAKY',
    'UNKNOWN'
);

ALTER TABLE "test_finding"
    ADD COLUMN "suspectedCause" TEXT,
    ADD COLUMN "suspectedKind" "test_failure_kind",
    ADD COLUMN "analysedAt" TIMESTAMP(3),
    ADD COLUMN "analysisModel" TEXT;
