-- The corrective half of 20260827120000_drop_publishing_topic_deferred_status
-- (Fizzy #2265 1D-1b, Fizzy #2307).
--
-- WHY A SECOND MIGRATION RATHER THAN A FIX TO THE FIRST. The original opens with
-- an unconditional `SET LOCAL row_security = off` before draining stray DEFERRED
-- rows. That statement grants nothing: for a role that bypasses RLS it is a
-- no-op, and for one that cannot it makes the next query whose result RLS would
-- affect raise 42501. Production is Neon, whose migration role carries the
-- bypass attribute, so the original applied there cleanly on 2026-08-27. The
-- dev/staging database is Databricks Lakebase, which grants BYPASSRLS to no role
-- at all — RLS runs in policy mode there, with permissive app_bypass /
-- worker_bypass policies standing in for the attribute — so the same file
-- aborted on the drain and took the staging deploy with it.
--
-- The obvious repair is to edit the original in place. That is exactly the case
-- docs/database-promotion.md tells you not to: Prisma stores a checksum per
-- applied migration, and production has this one recorded as applied, so an edit
-- would be rejected there. It would trade a staging blocker for a production
-- one. The original therefore stays byte-identical and this file carries the
-- correction forward, which is the only direction the runbook allows.
--
-- IDEMPOTENT BY CONSTRUCTION, because it has to run against both worlds. Where
-- the original succeeded the label is already gone and this is a no-op; where it
-- failed the label is still there and this does the whole rebuild. The check is
-- the label's own existence rather than a ledger lookup, so it stays correct
-- however the ledger was resolved by hand.
--
-- Note the operator step that goes with this differs from the runbook's usual
-- one. `--rolled-back` on the failed environment would make `migrate deploy`
-- re-run the ORIGINAL file and fail on the same SQL again — the runbook records
-- a rehearsal that put four mid-flight rows in the ledger that way. The failed
-- row is resolved `--applied` instead, which is safe ONLY because this file
-- performs that migration's work idempotently right after it.
--
-- The guard is conditional on the role's own capability. Two properties of that
-- check were established on a clone rather than assumed: BYPASSRLS is NOT
-- conferred by role membership (a role inheriting from a BYPASSRLS role still
-- raises 42501, so a membership-aware condition reads as a capability check and
-- is not one), and `SET LOCAL` inside a DO block persists for the rest of the
-- transaction. Where the guard stands down, correctness is still not left to the
-- drain: the ALTER COLUMN ... TYPE ... USING cast is DDL and so is not
-- RLS-filtered, so a surviving DEFERRED aborts the transaction with 22P02.
--
-- Every statement inside the block is EXECUTEd. plpgsql caches plans for
-- statements it parses directly, and half of these reference a type created
-- earlier in the same block; dynamic execution defers parsing to the point of
-- use, which is what makes that safe.
--
-- The locks and bounds are the original's, for the original's reasons: the
-- ACCESS EXCLUSIVE lock is what makes the drain's result hold until the swap
-- (an UPDATE takes only ROW EXCLUSIVE, so a concurrent INSERT of a DEFERRED row
-- would otherwise land between them and abort the cast), and taking it first
-- removes a lock upgrade that a concurrent reader can turn into a deadlock the
-- migration loses. lock_timeout bounds the wait, statement_timeout bounds the
-- rewrite, and both must precede the ALTER, which has already taken its lock.

-- migration-lint: allow type-change — the column is not changing type in the
-- ordinary sense; it is being repointed at a rebuilt version of its own enum,
-- which is the only way Postgres removes a label. Same rationale as the
-- migration this one corrects.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

DO $migrate$
BEGIN
  -- Already contracted (production, via the original migration) — nothing to do.
  --
  -- Bound to the OID of the type `publishing_topic.status` actually uses, not to
  -- the type NAME: enum names are unique per schema, not per database, so a
  -- same-named enum elsewhere that still carried DEFERRED would otherwise send
  -- an already-contracted production database down the rebuild path, take an
  -- ACCESS EXCLUSIVE lock, and fail parsing 'DEFERRED' against the contracted
  -- type it actually has.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_enum e ON e.enumtypid = a.atttypid
    WHERE a.attrelid = '"publishing_topic"'::regclass
      AND a.attname = 'status'
      AND NOT a.attisdropped
      AND e.enumlabel = 'DEFERRED'
  ) THEN
    RETURN;
  END IF;

  IF (
    SELECT rolsuper OR rolbypassrls
    FROM pg_catalog.pg_roles
    WHERE rolname = current_user
  ) THEN
    EXECUTE 'SET LOCAL row_security = off';
  END IF;

  EXECUTE 'LOCK TABLE "publishing_topic" IN ACCESS EXCLUSIVE MODE';
  EXECUTE 'UPDATE "publishing_topic" SET "status" = ''SUGGESTION'' WHERE "status" = ''DEFERRED''';
  EXECUTE 'CREATE TYPE "publishing_topic_status_new" AS ENUM (''SUGGESTION'', ''SELECTED'', ''IN_PROGRESS'', ''PUBLISHED'', ''DECLINED'')';
  EXECUTE 'ALTER TABLE "publishing_topic" ALTER COLUMN "status" DROP DEFAULT';
  EXECUTE 'ALTER TABLE "publishing_topic" ALTER COLUMN "status" TYPE "publishing_topic_status_new" USING ("status"::text::"publishing_topic_status_new")';
  EXECUTE 'ALTER TYPE "publishing_topic_status" RENAME TO "publishing_topic_status_old"';
  EXECUTE 'ALTER TYPE "publishing_topic_status_new" RENAME TO "publishing_topic_status"';
  EXECUTE 'DROP TYPE "publishing_topic_status_old"';
  EXECUTE 'ALTER TABLE "publishing_topic" ALTER COLUMN "status" SET DEFAULT ''SUGGESTION''';
END
$migrate$;

COMMIT;
