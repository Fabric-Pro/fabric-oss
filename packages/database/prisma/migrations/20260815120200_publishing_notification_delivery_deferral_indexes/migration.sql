-- Must be the first executable statement: it bounds the wait for every lock this file takes, and
-- the CREATE INDEX statements below take SHARE on a table other sessions write. SET LOCAL is scoped
-- to a transaction and silently no-ops outside one, so Prisma's transaction wrapping — which the
-- rollback argument below also rests on — is what makes this 5-second bound real at all, not merely
-- what makes a failure clean.
SET LOCAL lock_timeout = '5s';

-- Publishing Suite 1C-2d-1b (Fizzy #2213): the two indexes the reconciliation sweep needs.
--
-- migration-lint: allow blocking-index — this ledger was created three migrations ago
-- (20260812120300) and the suite that writes it is off by default in production, so the table is
-- empty there and holds test volume only elsewhere; both builds are milliseconds. Note the limit of
-- the SET LOCAL above: lock_timeout bounds the WAIT to acquire, never the HOLD, so what makes an
-- ordinary build safe here is the row count, not the timeout. Same call, same reasoning as
-- 20260804163800_add_project_favorite_and_visit. Once the suite is enabled in production and this
-- ledger is write-hot, any LATER index on this table must be CREATE INDEX CONCURRENTLY in its own
-- single-statement migration.
--
-- Ordinary CREATE INDEX is chosen over CONCURRENTLY deliberately, and it is the safer of the two
-- here. Prisma wraps this multi-statement file in one transaction, so a failed build rolls back
-- whole and leaves NO INVALID INDEX behind. CONCURRENTLY cannot run in a transaction and leaves
-- exactly that on failure: an index the planner refuses to use, in an environment that believes it
-- is protected. That is a failure class this file declines to create rather than one it recovers
-- from.
--
-- Deliberately no IF NOT EXISTS. PostgreSQL matches on the NAME alone, so it would silently accept
-- a differently-shaped index already holding the name and record this migration applied over it.
--
-- IF THIS MIGRATION IS UNRESOLVED IN _prisma_migrations, READ THE CATALOG BEFORE RESOLVING IT.
-- The transaction above covers the DDL, not Prisma's bookkeeping, which stamps finished_at after
-- the commit. Three states are reachable: two of them take OPPOSITE commands and the third takes
-- NEITHER, so there is no safe default to reach for.
--   NEITHER index exists -> the statement failed and rolled back
--                            -> prisma migrate resolve --rolled-back <this migration>, then re-run
--   BOTH exist, BOTH valid, and BOTH definitions match this file exactly
--                        -> the commit succeeded and the process died before the ledger write
--                            -> prisma migrate resolve --applied <this migration>
--                           "both names present" is NOT sufficient. If either is invalid or its
--                           definition differs, these are not our indexes: the first CREATE failed
--                           against a pre-existing name and the rollback left someone else's
--                           objects standing. Treat that as the EXACTLY ONE case below.
--   EXACTLY ONE exists   -> a name was already taken (the collision this file fails on by design),
--                           or someone hand-applied part of it. NEITHER command is safe blindly:
--                           read pg_get_indexdef on the one present. Not this file's definition ->
--                           drop it, --rolled-back, re-run. Is this file's definition -> finish the
--                           catalog by hand to match this file exactly, then --applied.
-- Running --rolled-back in the "both" case makes the re-run fail on "relation already exists",
-- because there is no IF NOT EXISTS above. That failure is loud and costs one command to correct;
-- it is not data loss. Confirm which state you are in with:
--   SELECT c.relname, i.indisvalid, pg_get_indexdef(i.indexrelid)
--     FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--    WHERE c.relname IN ('publishing_notification_delivery_deferred_drain_idx',
--                        'publishing_notification_delivery_sending_lease_idx');
-- Name the two exactly. A LIKE over this table's indexes also returns
-- publishing_notification_delivery_projectId_createdAt_idx, which has been there since the table
-- was created and has nothing to do with this migration — a diagnostic that reports it is a
-- diagnostic that miscounts the states above.

-- The size premise, ENFORCED rather than asserted. Everything above argues this table is small;
-- an argument is not a measurement, and the environments that run this migration are not the one
-- it was written on. Above the threshold the write stall stops being self-evidently negligible and
-- the blocking-vs-concurrent choice must be re-taken by a human with the real number in hand. The
-- whole file is one transaction, so a refusal here changes nothing at all.
-- Take SHARE here rather than letting the first CREATE INDEX take it incidentally. SHARE is the
-- lock CREATE INDEX needs anyway, so acquiring it early costs only the bounded probe's duration —
-- and without it the measurement below is advisory rather than binding. A count takes ACCESS SHARE,
-- which does not block writers, and under READ COMMITTED each statement opens a new snapshot: a
-- bulk writer invisible to the probe can commit between the check and the build, and the build then
-- runs over a table far larger than the one that passed. Holding SHARE across both freezes what was
-- measured. lock_timeout above bounds the wait for it.
LOCK TABLE "publishing_notification_delivery" IN SHARE MODE;

DO $$
DECLARE probe_count bigint;
BEGIN
  -- SIZE FIRST, AND THE ORDER IS THE POINT.
  --
  -- pg_relation_size is a catalog and filesystem read: O(1), no pages touched. The tuple probe
  -- below is not. A relation with few LIVE tuples over a large bloated heap forces that probe to
  -- scan the whole thing before it can conclude there is no 50001st row — while holding SHARE, and
  -- blocking every writer. That is precisely the outage the size ceiling exists to prevent, and
  -- running the probe first meant the guard performed it on the way to deciding not to allow it.
  -- A check that inflicts the harm it is checking for is not a check.
  --
  -- Live rows alone are also reassuring and wrong: a build reads PAGES, not tuples. Dead row
  -- versions awaiting vacuum and wide rows both inflate the heap without moving the count, so a
  -- ledger churned hard and vacuumed late shows 50000 live rows over a heap orders of magnitude
  -- larger.
  IF pg_relation_size('"publishing_notification_delivery"') > 134217728 THEN
    RAISE EXCEPTION
      'publishing_notification_delivery occupies % bytes, above the 128MB ceiling this migration builds under — the heap is bloated or the rows are wide, regardless of the live row count. VACUUM (FULL) is not the answer under deployment pressure: rewrite the two indexes as CREATE INDEX CONCURRENTLY, each in its own single-statement migration.',
      pg_relation_size('"publishing_notification_delivery"');
  END IF;

  -- Only now, with the physical size known to be bounded, is a scan safe to run. Bounded anyway:
  -- a plain count(*) must read every visible row before reporting that there are too many, so the
  -- check meant to prevent a long deployment query would become one. Stopping at the ceiling plus
  -- one answers the only question being asked. The cost is that the message cannot name the true
  -- count — a fair trade, since the operator's next step is to measure it deliberately rather than
  -- read it from a log.
  SELECT count(*) INTO probe_count
    FROM (SELECT 1 FROM "publishing_notification_delivery" LIMIT 50001) AS probe;

  IF probe_count > 50000 THEN
    RAISE EXCEPTION
      'publishing_notification_delivery holds more than 50000 rows, the ceiling this migration builds under. Do not raise the ceiling to get past this: rewrite the two indexes as CREATE INDEX CONCURRENTLY, each in its own single-statement migration, and read docs/database-promotion.md for the invalid-index recovery that then becomes necessary.';
  END IF;
END $$;

-- The drain page. The sweep walks DEFERRED rows in (expiresAt, id) order with a keyset cursor that
-- is reset on every run, so each run re-walks from the start. Without this index that is a filter
-- and a sort of the whole ledger, and the backlog this design exists for is exactly when the ledger
-- is largest. "id" is in the key, not decoration: one cycle's close creates a whole batch of
-- deferrals sharing an identical TIMESTAMP(3) expiry, and inside that tie the cursor can only seek
-- if "id" is indexed. Partial, so it covers only rows in a transient state, never the history.
--
-- THE SWEEP MUST EMIT THE DELIVERY STATUS AS A LITERAL, NEVER AS A BIND PARAMETER. A partial index
-- is reachable only where the query's predicate provably IMPLIES the index predicate, and a
-- generic plan has no value with which to prove status = $1 implies status = 'DEFERRED' — so a
-- parameterized sweep misses BOTH indexes in this file and falls back to a sequential scan and a
-- sort of the whole ledger. No test enforces this on the sweep: the suite records the property
-- against these indexes, it cannot see how 1C-2d-2 eventually writes the query.
CREATE INDEX "publishing_notification_delivery_deferred_drain_idx"
  ON "publishing_notification_delivery" ("expiresAt", "id")
  WHERE "status" = 'DEFERRED';

-- The lease-reclaim scan. The sweep's first pass finds SENDING rows whose lease has expired and
-- returns them to DEFERRED — the route a crashed worker depends on. It reads oldest claim first, so
-- this index serves the predicate and the ordering together. A different query shape does not use
-- it: the pass must ORDER BY "claimedAt" ASC.
CREATE INDEX "publishing_notification_delivery_sending_lease_idx"
  ON "publishing_notification_delivery" ("claimedAt")
  WHERE "status" = 'SENDING';
