-- Publishing Suite 1C-2d-2a (Fizzy #2213): the two indexes the cycle sweep's
-- reads are bounded by, and the extended statistics object without which the
-- planner does not take the second one.
--
-- THREE OBJECTS, ONE PROPERTY. An index only makes a plan AVAILABLE. Two of the
-- three things here exist because availability is not the same as reachability:
-- the `IS NOT NULL` term on the stale index stops it competing for the
-- enrolment page, and the MCV statistics object stops the planner mis-costing
-- the walk it should take. Each of the three is measured in the comment above
-- the statement that creates it.
--
-- migration-lint: allow blocking-index — both builds are PARTIAL on the PENDING
-- population only, which is in-flight work rather than history, and the whole
-- file is one transaction so a failed build leaves no invalid index behind. The
-- marker's parse is exact: the whitespace before the separator is load-bearing
-- (packages/database/scripts/lint-migrations.ts:286-296).
--
-- lock_timeout FIRST. CREATE INDEX takes SHARE on a table other sessions write,
-- and a timeout declared after the first CREATE would guard nothing.
SET LOCAL lock_timeout = '5s';

-- Take SHARE here rather than letting the first CREATE INDEX take it
-- incidentally: without it the size measurement below is advisory rather than
-- binding, because under READ COMMITTED a bulk writer invisible to the probe can
-- commit between the check and the build.
--
-- AND NOTE WHAT THAT COSTS, because the row ceiling's message says it and it is
-- easy to read as "the builds". A lock taken inside a transaction is held until
-- COMMIT, so SHARE is held from HERE to the end of the file: the probe, both
-- builds, the statistics object, its ANALYZE and the commit itself. A writer
-- arriving anywhere in that window waits for the whole remainder, not for the
-- statement that happens to be running. Measured at the row ceiling on
-- postgres:16, 12 runs: total hold 269-329 ms, writer wait 270-331 ms, the two
-- tracking each other every time.
LOCK TABLE "publishing_suggestion_cycle" IN SHARE MODE;

DO $$
DECLARE probe_count bigint;
BEGIN
  -- SIZE FIRST, AND THE ORDER IS THE POINT. pg_relation_size is O(1); the tuple
  -- probe is not, and running it first would perform the scan the guard exists
  -- to prevent while holding SHARE.
  IF pg_relation_size('"publishing_suggestion_cycle"') > 134217728 THEN
    RAISE EXCEPTION
      'publishing_suggestion_cycle occupies % bytes, above the 128MB ceiling this migration builds under — the heap is bloated or the rows are wide, regardless of the live row count. THIS CEILING BOUNDS THE FLOOR EVERY BUILD PAYS: a partial index build reads every heap page to decide which rows match, so it costs this much even with zero matching rows (measured: 71 ms over a 248MB heap holding no PENDING cycles). Do not raise it. Rewrite both indexes as CREATE INDEX CONCURRENTLY, each in its own single-statement migration, and read docs/database-promotion.md:323-331 for the invalid-index recovery that then becomes necessary.',
      pg_relation_size('"publishing_suggestion_cycle"');
  END IF;

  -- SCOPED TO THE PENDING POPULATION, NOT TO THE TABLE, AND THAT IS THE WHOLE
  -- CORRECTION (Decision 16b). An earlier draft counted every row and refused
  -- above 50000, on a table that gains one row per project per cadence tick and
  -- never loses one -- so it refused on any real deployment, and a refusal here
  -- aborts the deploy pass before the two VALIDATE statements in the next file.
  -- The size check above already bounds the heap scan; what it does NOT bound is
  -- the sort-and-write term, which scales with the rows that actually enter the
  -- index: measured on a fixed 248MB heap, 71 ms at 0 PENDING and 1763 ms at
  -- 2000000. THAT is the population worth a second ceiling, and it is the
  -- population the two indexes below PARTITION between them.
  --
  -- Partition, not share, and that is what makes ONE ceiling enough for TWO
  -- builds. The stale index carries `notificationOutcomeAt IS NOT NULL` and the
  -- null-clock index carries `IS NULL`, so a PENDING row enters exactly one of
  -- them and the two builds sort this ceiling's worth of rows BETWEEN them
  -- however the population splits. Measured at the ceiling, 500000 PENDING:
  -- all-null-clock 33 + 137 ms, all-clocked 143 + 33 ms, half-and-half
  -- 73 + 71 ms -- the same total either way. Before the IS NOT NULL term both
  -- indexes covered every null-clock row, so that worst case was twice this.
  --
  -- The probe cannot be expensive: no index serves this predicate yet -- these
  -- two ARE it -- so it is a filtered scan, bounded by the heap the check above
  -- has already refused to exceed. Measured at 40.8 ms on a 74MB heap.
  SELECT count(*) INTO probe_count
    FROM (SELECT 1 FROM "publishing_suggestion_cycle"
           WHERE "notificationOutcome" = 'PENDING'
           LIMIT 500001) AS probe;

  IF probe_count > 500000 THEN
    RAISE EXCEPTION
      'more than 500000 PENDING cycles, the ceiling these two partial index builds run under. At that population this transaction holds SHARE on the table from the LOCK TABLE above until COMMIT -- the probe, BOTH index builds, the statistics object and its ANALYZE, not one of them -- and any writer arriving inside that window waits for ALL of it, not for the longest statement. Measured on postgres:16 (16.14, maintenance_work_mem 64MB, 2 parallel maintenance workers) at exactly this ceiling, over all three ways the population can split between the two partial indexes, 12 runs of 12: total hold 269-329 ms, concurrent writer wait 270-331 ms, the wait tracking the whole transaction in every run. Read the SHAPE, not the digits: the digits are one machine and one warm cache. Do not raise the ceiling. TO UNBLOCK THE PROMOTION, run "prisma migrate resolve --applied 20260815120380_publishing_suggestion_cycle_pending_sweep_indexes" and re-run migrate deploy: the release ships and the sweep still works, reading the whole cycle table on every pass instead of two index pages -- correct, unbounded, and safe for hours rather than for a quarter. Then rewrite both indexes as CREATE INDEX CONCURRENTLY, each in its own single-statement migration, in a follow-up.';
  END IF;
END $$;

-- THE STALE SIDE. The sweep walks PENDING cycles in notificationOutcomeAt order
-- and stops at the page. Without this index that is a parallel sequential scan
-- and a sort of every cycle ever created, and the cheapest case — nothing stale
-- left — is the one that pays most, because it cannot stop early.
--
-- "notificationOutcome" IS A LITERAL IN EVERY STATEMENT THAT USES THIS INDEX. A
-- partial index is reachable only where the query predicate provably IMPLIES the
-- index predicate, and a generic plan has no value with which to prove
-- "notificationOutcome" = $1 implies = 'PENDING'. Same rule, same reason, as
-- 20260815120200_..._deferral_indexes:117.
--
-- THE `IS NOT NULL` TERM IS NOT DECORATION -- it is what stops this index being
-- a RIVAL to the null-clock index below. Without it a null-clock row is in BOTH
-- indexes (a NULL key is still a key), so the enrolment predicate
-- `notificationOutcome = 'PENDING' AND notificationOutcomeAt IS NULL` can be
-- served by EITHER -- and this one serves it by scanning every null-clock entry
-- and then SORTING, because its key order is the wrong one for that page.
-- Measured on postgres:16 with the two indexes as first shipped, 600,000 cycles
-- of which 5,000 were PENDING with a NULL clock, every non-index path disabled
-- and the null-clock index dropped: this index served the enrolment predicate
-- via `Index Cond: ("notificationOutcomeAt" IS NULL)`, top-N heapsort over
-- actual rows=5000, 5,031 buffers to return 100. With the term below present the
-- same probe cannot reach this index at all and falls back to a sequential scan
-- -- which is the proof, because a fallback means no index path exists.
--
-- The query predicate still implies this one: `notificationOutcomeAt < X` is a
-- strict comparison, so it implies `notificationOutcomeAt IS NOT NULL` and the
-- abandon page keeps reaching this index unchanged (measured: same Index Scan,
-- same Index Cond, 202 buffers for a 100-row page, and the LIMIT 1 probe is
-- still an Index Only Scan at 3 buffers).
--
-- It also makes the two indexes PARTITION the PENDING population instead of
-- overlapping it, which is what bounds the build below: the two builds together
-- sort at most as many rows as the ceiling admits, however the population splits
-- between them.
CREATE INDEX "publishing_suggestion_cycle_pending_stale_idx"
  ON "publishing_suggestion_cycle" ("notificationOutcomeAt", "id")
  WHERE "notificationOutcome" = 'PENDING' AND "notificationOutcomeAt" IS NOT NULL;

-- THE NULL-CLOCK SIDE, and it is a SECOND index rather than two more columns on
-- the first for a measured reason. PostgreSQL does not treat IS NULL on a
-- leading index column as an equality for ordering purposes, so a composite
-- ("notificationOutcomeAt","updatedAt","id") reaches this predicate but then
-- SORTS the whole null-clock population before the LIMIT can apply — bounded
-- writes over unbounded reads, one layer down.
--
-- WHAT THIS INDEX GUARANTEES, AND WHAT IT DOES NOT. An earlier version of this
-- comment claimed the index alone "makes the enrolment page an ordered walk that
-- stops at 100". It does not, and the fixture that appeared to show it did was
-- unrepresentative: it appended the null-clock rows in one block, so a
-- whole-population read touched 83 contiguous heap pages and looked free. On the
-- interleaved fixture a rolling deploy actually produces -- 5,000 null-clock
-- PENDING scattered through 600,000 cycles -- the ordered page instead reads
-- every matching row and top-N sorts it: 5,131 buffers to return 100.
--
-- The reason is an ESTIMATE, not an index. `notificationOutcome = 'PENDING'` and
-- `notificationOutcomeAt IS NULL` are perfectly correlated here, and the planner
-- multiplies their selectivities as if they were independent: it predicts 43
-- rows where 5,000 match, and at 43 rows a sort is cheaper than an ordered walk.
-- The extended statistics object below is what corrects that. Of the three
-- candidate remedies measured it is the only one that produces the ORDERED WALK
-- this comment describes: with it the same page is `Index Scan using
-- ..._pending_null_clock_idx`, actual rows=100, no Sort, 202 buffers on that
-- fixture -- and it stays an ordered walk at roughly 200-300 buffers at every
-- population measured (0 / 200 / 5,000 / 50,000 / 150,000 null-clock rows).
-- Dropping the page's ORDER BY also bounds the heap side, but it leaves a bitmap
-- over the whole null-clock population (25 buffers at 5,000, 239 at 50,000) and
-- degenerates to a Seq Scan higher up, so it was not chosen.
--
-- So what this index guarantees on its own is that an ordered walk EXISTS. The
-- statistics object is what makes the planner take it, and the `IS NOT NULL`
-- term above is what stops the other index competing for it.
--
-- It also self-empties: a row leaves this index the moment it is enrolled, so in
-- steady state it holds nothing at all.
CREATE INDEX "publishing_suggestion_cycle_pending_null_clock_idx"
  ON "publishing_suggestion_cycle" ("updatedAt", "id")
  WHERE "notificationOutcome" = 'PENDING' AND "notificationOutcomeAt" IS NULL;

-- THE ESTIMATE, WHICH IS THE OTHER HALF OF THE INDEX ABOVE (see its comment).
--
-- (mcv) AND NOTHING ELSE, because only the MCV list moves this estimate and the
-- other two kinds are not free. Measured on postgres:16, 600,000 cycles / 5,000
-- null-clock PENDING, each variant built and ANALYZEd from scratch:
--
--   no statistics object              estimate    43   Sort   5,131 buffers
--   (dependencies) only               estimate    36   Sort   5,131 buffers
--   (mcv) only                        estimate 4,800   walk     202 buffers
--   all kinds (ndistinct+deps+mcv)    estimate 4,760   walk     202 buffers
--   (mcv) ON outcome, (clock IS NULL) estimate    43   Sort   5,131 buffers
--
-- The last row is worth keeping: an EXPRESSION statistic on `(clock IS NULL)`
-- reads like the natural way to state the correlation and does nothing, because
-- the clause in the query is a NullTest on a plain column and never matches the
-- expression. Functional dependencies do nothing either -- they answer equality
-- clauses, not NullTests. The MCV list is the only kind that records a NULL flag
-- per column, which is exactly what is being asked about here.
--
-- ANALYZE IS IN THIS FILE ON PURPOSE. CREATE STATISTICS only declares the
-- object; ANALYZE is what fills it, and until it does the planner falls straight
-- back to the multiplied-selectivity estimate and the 5,131-buffer plan above.
-- Leaving that to autoanalyze would mean shipping the fix and not getting it
-- until the table next churns 10%.
--
-- WHAT THIS FILE PAYS FOR ANALYZE IS THE WHOLE STATEMENT, NOT A MARGIN. This
-- file carried no ANALYZE at all before this migration, so there is no "ANALYZE
-- that would have run anyway" inside ITS OWN transaction to net against. The
-- ~30 ms figure sometimes quoted for this (104 ms WITH the statistics object
-- against 75 ms WITHOUT, on the Finding-1 fixture above) is the OBJECT's own
-- marginal cost over a bare ANALYZE -- true of the object, not of the file.
-- Measured on postgres:16 (16.14), the statement in isolation, at the
-- 500,000-row ceiling (all-null-clock split), 8 runs: ANALYZE itself 65-75 ms,
-- roughly 22-27% of the 256-312 ms this transaction holds SHARE for end to end
-- on that fixture. The row-ceiling RAISE EXCEPTION below and the LOCK TABLE
-- comment above already report that whole hold, ANALYZE included; this
-- paragraph is only about ANALYZE's own slice of it.
--
-- On a FRESH database this ANALYZE runs over an empty table, so the object ships
-- empty and autoanalyze fills it once rows exist. That is the right way round:
-- the estimate only starts mattering once the population is large enough to sort.
--
-- A LOGICAL RESTORE reaches the SAME empty state, and it earns its own sentence
-- because it can land on a table already full of PENDING rows rather than an
-- empty one. pg_dump emits this statement's CREATE STATISTICS declaration but
-- never the collected MCV list: verified directly on postgres:16 (16.14) --
-- zero occurrences of pg_statistic_ext_data or stxdmcv in either a
-- --schema-only or a full data dump of a database carrying this object filled,
-- and after restoring the full dump the object's pg_statistic_ext_data row does
-- not exist at all, not merely unfilled. A database refreshed from a production
-- dump therefore lands this object empty AT FULL POPULATION, not empty-and-
-- growing, and the planner falls back to the pre-fix plan until something
-- ANALYZEs the table: measured on the 600,000-row / 5,000-null-clock fixture
-- above, restored and queried before any post-restore ANALYZE, the enrolment
-- page reverts to Bitmap Heap Scan + Sort over all 5,000 matching rows, 5,181
-- buffers, against 252 once ANALYZE runs. RUN ANALYZE
-- "publishing_suggestion_cycle" (or vacuumdb --analyze-only) as an explicit
-- step of the restore procedure rather than waiting on autoanalyze: this table
-- only grows, so crossing the default 10% autovacuum_analyze_scale_factor from
-- a full-size restore can take far longer than an operator should accept an
-- empty MCV for.
CREATE STATISTICS "publishing_suggestion_cycle_notification_clock_stx" (mcv)
  ON "notificationOutcome", "notificationOutcomeAt"
  FROM "publishing_suggestion_cycle";

ANALYZE "publishing_suggestion_cycle";
