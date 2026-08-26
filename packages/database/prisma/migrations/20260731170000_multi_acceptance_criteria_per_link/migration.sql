-- A test case can cover more than one acceptance criterion.
--
-- `acceptanceCriterionRef` held a single nullable reference per case-to-work-item
-- link, so a case that genuinely proves AC 1, AC 3 and AC 7 could name one of
-- them. The traceability matrix counted it under that one row and silently
-- under-reported the other two — the coverage figure said less than the suite
-- actually did, which is the wrong direction for a number people rely on.
--
-- An array rather than a join table. These references are short free text
-- (`AC 3`, `3`, `criterion 2`), are never joined against, and are only ever read
-- as a set belonging to one link. A join table would add a relation and a query
-- to answer nothing the array cannot.
--
-- EXPAND ONLY. The old column stays for now.
--
-- Dropping it here would break every app instance still running the previous
-- release during the rollout window: they select `acceptanceCriterionRef`, and
-- it would already be gone. The contract half — dropping the column — belongs in
-- a later migration, once this release has fully rolled out.
--
-- No code reads or writes the old column after this change, so there is no
-- drift risk in the meantime: it is a dead column awaiting its contract phase,
-- not a second source of truth.
ALTER TABLE "test_case_work_item_link"
  ADD COLUMN "acceptanceCriterionRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: an existing reference becomes a one-element list.
--
-- The `btrim` guard is load-bearing. Whitespace-only references exist in the
-- data, and 2026-07-31 established that whitespace counts as no reference at all
-- — a case with a blank box never tried to map itself, and reporting it as
-- "mapped to ' '" would put an unresolvable entry in the compliance export.
-- Without this guard those rows would backfill as `[' ']` and read as a mapping
-- attempt forever.
UPDATE "test_case_work_item_link"
   SET "acceptanceCriterionRefs" = ARRAY["acceptanceCriterionRef"]
 WHERE "acceptanceCriterionRef" IS NOT NULL
   AND btrim("acceptanceCriterionRef") <> '';
