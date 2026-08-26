-- Publishing Suite 1C-2d-2a (Fizzy #2213): backfill the activation clock for
-- PENDING cycles that existed before the column did.
--
-- ITS OWN FILE, so the ACCESS EXCLUSIVE the previous migration took has already
-- been released at that file's COMMIT. This one takes ROW EXCLUSIVE and readers
-- of the cycle table are unaffected.
--
-- IDEMPOTENT BY PREDICATE. A failed migration is re-run after
-- `prisma migrate resolve --rolled-back`, and `notificationOutcomeAt IS NULL`
-- already makes a second run a no-op -- there is no ON CONFLICT to write and no
-- state to detect.
--
-- Its DIRECTION is the point, and the FLOOR is what supplies it.
--
-- updatedAt alone is NOT an upper bound on the true activation instant, which is
-- what an earlier draft assumed. @updatedAt is CLIENT-side, so a worker whose
-- clock trails this one stamps a value BELOW the real activation -- and the
-- sweep would then terminalize a live cycle. GREATEST with this transaction's
-- own database clock makes the value never earlier than the moment the schema
-- first saw the row; GREATEST rather than the clock alone so a worker whose
-- clock runs AHEAD keeps its later value. Conservative in BOTH skew directions.
-- The alert is delayed, never manufactured, and ABANDONED is irreversible.
--
-- clock_timestamp(), not now(): the floor is a VALUE WRITTEN, and Decision 33
-- clause 1 says a value written reads the volatile clock rather than
-- transaction-start. The rule's clause 4 -- a terminal-deciding value must be
-- written by a statement that cannot WAIT between projecting the value and
-- committing it -- is discharged here by the lock_timeout above rather than by
-- SKIP LOCKED: this UPDATE waits at most five seconds against a two-hour
-- staleness bound, and a longer wait ABORTS the migration loudly instead of
-- committing a backdated floor. The sweep's own enrolment pass has no
-- lock_timeout to lean on and takes the other route; see Decision 31.
--
-- Bounded by the state it targets rather than by the table: PENDING is
-- in-flight work, not history. It does NOT empty permanently -- a worker on the
-- previous build can activate a cycle after this runs -- which is why the sweep
-- carries the bounded enrolment pass in Task 4 Step 2b (Decision 31) rather than
-- treating this backfill as the last word.
--
-- THE CEILINGS ARE IN THIS FILE, AND THE REASON IS A RECURRENCE (Decision 16a).
-- An earlier draft put them only in the NEXT migration, so on an oversized table
-- this UPDATE had already committed by the time the deploy aborted. That is the
-- same defect 20260815120200_..._deferral_indexes fixed inside itself, where the
-- tuple probe ran BEFORE the size check and the guard therefore performed the
-- blocking scan it existed to prevent (:76-93). Its own words: "A check that
-- inflicts the harm it is checking for is not a check." Same shape, new file:
-- A GUARD PLACED AFTER THE EXPENSIVE THING IT GUARDS IS NOT A GUARD.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE probe_count bigint;
BEGIN
  -- SIZE FIRST, AND THE ORDER IS THE POINT, for the reason the sibling file
  -- states at length: pg_relation_size is a catalog read, the tuple probe is a
  -- scan, and running the scan first performs the work the ceiling exists to
  -- refuse. It also bounds the UPDATE's OWN read -- there is no index on this
  -- predicate yet (the two partial indexes are the NEXT migration), so the
  -- UPDATE is a sequential scan of the whole relation and the physical size is
  -- exactly what bounds it.
  IF pg_relation_size('"publishing_suggestion_cycle"') > 134217728 THEN
    RAISE EXCEPTION
      'publishing_suggestion_cycle occupies % bytes, above the 128MB ceiling this backfill runs under -- the heap is bloated or the rows are wide, regardless of the live row count. Do not raise the ceiling: the backfill is a whole-relation scan with no index to lean on, so a heap this size is a long write-locking statement in a deploy. TO UNBLOCK THE PROMOTION, run "prisma migrate resolve --applied 20260815120350_publishing_cycle_notification_outcome_at_backfill" and re-run migrate deploy: the column ships, the rows stay NULL, and the sweep''s own bounded enrolment pass adopts them at 2000 an hour under the same floor this statement writes, reporting what is left on every run. Do NOT hand-run this UPDATE instead -- that is the statement the ceiling refused.',
      pg_relation_size('"publishing_suggestion_cycle"');
  END IF;

  -- Only now, with the physical size bounded, is a scan safe to run. The
  -- cardinality being bounded is the WRITE set, not the table: this statement
  -- writes only PENDING rows with no clock, and that is what determines the rows
  -- locked, the WAL generated and how long ROW EXCLUSIVE is held. Stopping at the
  -- ceiling plus one answers the only question being asked.
  --
  -- THIS NUMBER NO LONGER MATCHES THE SIBLING FILE'S, AND THE DIFFERENCE IS THE
  -- POINT (Decision 16b). Here 50000 bounds a WRITE SET: rows this statement
  -- locks and rewrites, and therefore the WAL it generates and how long
  -- ROW EXCLUSIVE is held. The index file's row ceiling bounds the population
  -- its two partial indexes SORT AND BUILD OVER, which is a different quantity
  -- measured at a different cost, so it is 500000 and it is scoped to PENDING.
  -- An earlier draft had both at 50000 over different populations and described
  -- that as deliberate symmetry; it was a number carried, not a number derived.
  SELECT count(*) INTO probe_count
    FROM (SELECT 1 FROM "publishing_suggestion_cycle"
           WHERE "notificationOutcome" = 'PENDING'
             AND "notificationOutcomeAt" IS NULL
           LIMIT 50001) AS probe;

  IF probe_count > 50000 THEN
    RAISE EXCEPTION
      'more than 50000 PENDING cycles carry no activation clock, the ceiling this backfill writes under. Do not raise the ceiling. TO UNBLOCK THE PROMOTION, run "prisma migrate resolve --applied 20260815120350_publishing_cycle_notification_outcome_at_backfill" and re-run migrate deploy: the rows stay NULL and the sweep''s bounded enrolment pass adopts them at 2000 per hourly run, under the same floor this statement writes, reporting what is left. A refusal here aborts the whole deploy pass, so nothing that ships in this release can be reached until it is resolved -- which is why the remedy is a resolve and not "wait for the pass".';
  END IF;
END $$;

-- ADVISORY, NOT BINDING, AND THE DIFFERENCE FROM THE SIBLING IS DELIBERATE. The
-- index file takes LOCK TABLE ... IN SHARE MODE before its probe, because SHARE
-- is the lock CREATE INDEX needs anyway, so freezing the measurement is free.
-- Here it would not be: any lock strong enough to freeze this measurement blocks
-- the writers this file's own boundary exists to spare (Decision 16, point 2 --
-- the whole reason the backfill is not in the ADD COLUMN file is that it takes
-- only ROW EXCLUSIVE). So under READ COMMITTED a writer invisible to the probe
-- can commit between the check and the UPDATE. That residue is one ordinary
-- writer wide -- this table gains one row per project per cadence tick and has
-- no bulk producer -- against an error that is otherwise unbounded.
UPDATE "publishing_suggestion_cycle"
   SET "notificationOutcomeAt" = GREATEST("updatedAt", (clock_timestamp() AT TIME ZONE 'UTC'))
 WHERE "notificationOutcome" = 'PENDING'
   AND "notificationOutcomeAt" IS NULL;
