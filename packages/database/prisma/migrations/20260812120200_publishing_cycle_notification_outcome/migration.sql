-- Publishing Suite 1C-2b: the cycle-level notification outcome (§9.7) and the shared lifecycle
-- version that fences its writers (§9.7 rule 4).
--
-- THE DEFAULT IS LOAD-BEARING, NOT COSMETIC. Every row that exists when this runs — and every row
-- later written by a worker that does not know about this feature, which is the rolling-deploy
-- case a backfill alone misses — classifies as NOT_APPLICABLE: "never entered the lifecycle",
-- which is the honest answer and the value monitoring excludes. No backfill UPDATE follows,
-- because a NOT NULL DEFAULT has already done the whole job; a statement matching zero rows would
-- read as load-bearing to the next person.
--
-- The version stays at 0 for every existing row so that a cycle genuinely mid-flight when this
-- lands is not frozen: the running activity's compare-and-swap succeeds against the unchanged
-- version.
ALTER TABLE "publishing_suggestion_cycle"
  ADD COLUMN "notificationOutcome" TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN "notificationOutcomeVersion" INTEGER NOT NULL DEFAULT 0;

-- The allowlist is declared ONCE, with all nine values, even though two have no writer until a
-- later slice (MAIL_NOT_CONFIGURED from 1C-2c, ABANDONED from 1C-2d). An allowlist entry nobody
-- writes is inert, whereas splitting this CHECK per slice would cost three expand sequences on a
-- table live since Phase 1A. The ledger's own status CHECK takes the opposite, stricter rule for
-- the mirror-image reason: it is created empty, so each widening there is free.
--
-- NOT VALID, because publishing_suggestion_cycle is LIVE. A validating ADD CONSTRAINT takes
-- ACCESS EXCLUSIVE and scans every row — being a single statement avoids Prisma's transaction
-- wrapper but says nothing about lock behaviour; those are two independent constraints. NOT VALID
-- takes the lock only briefly, enforces the rule on all NEW writes immediately, and does not scan.
-- VALIDATE CONSTRAINT ships in 1C-2c, a LATER RELEASE: `promote` runs every pending migration in
-- one `prisma migrate deploy` pass, so two files in one release are not separately scheduled and
-- the split would buy nothing. The obligation is recorded in
-- prisma/pending-constraint-validations.json and enforced by scripts/lint-migrations.ts.
--
-- lock_timeout is SET LOCAL in this migration's own session: preflight-migrate.ts sets one on its
-- OWN connection, which is not the one `prisma migrate deploy` uses, so it does not carry over.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "publishing_suggestion_cycle"
  ADD CONSTRAINT "publishing_suggestion_cycle_notification_outcome_check"
  CHECK ("notificationOutcome" IN (
    'NOT_APPLICABLE','PENDING','ABANDONED','SENT','NO_RECIPIENTS',
    'CANCELLED','DISABLED','MAIL_NOT_CONFIGURED','RESOLUTION_FAILED')) NOT VALID;
