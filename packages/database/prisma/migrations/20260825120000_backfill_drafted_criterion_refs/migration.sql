-- Repair criterion references the AI drafter stranded on the dead column.
--
-- 20260731170000_multi_acceptance_criteria_per_link backfilled
-- `acceptanceCriterionRefs` from `acceptanceCriterionRef` for rows that existed
-- at migration time. The drafting activity was missed in that contract change:
-- it kept writing the singular column until this fix, so every link it created
-- AFTER that migration carries a singular value with an EMPTY array — invisible
-- to coverage, the traceability matrix and the Done gate, which all read only
-- the array. This finishes what that backfill started.
--
-- Scoped by createdAt to links created after that migration, because the
-- singular-plus-empty-array shape is only unambiguous there:
--
--   - After 2026-07-31 the ONLY writer touching the singular column was the
--     drafting activity, so such a row is always a stranded draft.
--   - Before it, the singular value was live data. The earlier backfill copied
--     those into arrays; if a user has since cleared the references through
--     the API (which writes the array alone), the stale singular still sits on
--     the row — re-copying it here would resurrect a reference the user
--     deliberately removed.
--
-- Idempotent: rows already carrying refs are never matched again.
UPDATE "test_case_work_item_link"
   SET "acceptanceCriterionRefs" = ARRAY["acceptanceCriterionRef"]
 WHERE "createdAt" >= TIMESTAMPTZ '2026-07-31 17:00:00+00'
   AND "acceptanceCriterionRefs" = '{}'
   AND "acceptanceCriterionRef" IS NOT NULL
   AND btrim("acceptanceCriterionRef") <> '';
