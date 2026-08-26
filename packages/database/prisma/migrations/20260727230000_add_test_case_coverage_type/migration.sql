-- Which level of the test pyramid a case sits at (spec §7.4 A4).
--
-- The traceability matrix could count coverage per criterion but not
-- characterise it, and "three cases" means something very different when all
-- three are manual clickthroughs than when one is a unit test, one an
-- integration test and one an E2E run.
--
-- Deliberately nullable with no backfill: every existing case has no honest
-- answer, and stamping them all with one level would invent data. A column full
-- of confidently wrong values is worse than one that admits it does not know.

CREATE TYPE "qa_coverage_type" AS ENUM ('UNIT', 'INTEGRATION', 'E2E', 'MANUAL');

ALTER TABLE "test_case" ADD COLUMN "coverageType" "qa_coverage_type";
