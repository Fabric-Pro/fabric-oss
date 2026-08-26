-- Fizzy #2264 PR B — project-level role confirmation (spec §5.1, §5.7).
--
-- Two columns, no backfill. `confirmedAt` NULL is the correct "unconfirmed"
-- default for every existing row, and `confirmationVersion` starts at 0.
--
-- lock_timeout FIRST: both ALTERs below take ACCESS EXCLUSIVE and CREATE
-- TRIGGER takes SHARE ROW EXCLUSIVE, on a table written on every
-- invite-accept — bound the wait rather than queue every writer behind an
-- open transaction at server defaults.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "project_user_function_tag" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "project_user_function_tag" ADD COLUMN "confirmationVersion" INTEGER NOT NULL DEFAULT 0;

-- The version invariant, HELD (not merely checked) where every writer passes.
--
-- `confirmationVersion` is the compare-and-set token a member's confirmation is
-- conditional on. A writer that changes `tags` or `confirmedAt` without
-- advancing it does not fail — it silently disarms the CAS, leaving an old
-- expectedVersion valid forever, which is how an open prompt would come to
-- overwrite an administrator's assignment with a success toast.
--
-- The application-side choke point and the per-writer tests cannot hold this:
-- neither can fail for a write path that does not exist yet. A row-level
-- BEFORE trigger applies to EVERY role including the table owner, so it also
-- covers a direct `db.projectUserFunctionTag.update()` written anywhere else.
--
-- This trigger ADVANCES the version itself rather than raising, and warns.
-- The design spec specified `RAISE EXCEPTION`; that form is unsafe to ship in
-- one release here, and the corrective form is also the stronger guarantee:
--
--   * The migration and the app that runs these writers deploy from SEPARATE,
--     UNORDERED workflows. Every writer here lives in the web app, which
--     deploys on a release tag with no dependency on the migration job, so
--     neither ordering is guaranteed. A rejecting trigger breaks the
--     migration-first order (instances of the previous version fail every
--     invite-accept and admin tag edit, on writers correct for the code they
--     shipped with). The corrective form is right under BOTH orderings, which
--     is why it was chosen.
--   * Correcting instead of rejecting makes "any change to tags or confirmedAt
--     advances the version" unconditionally TRUE, for old, current and future
--     writers alike. The compare-and-set can no longer be disarmed by anyone;
--     a checker only reports that it was.
--   * The cost is that a forgetful writer is corrected quietly instead of
--     failing loudly. The `RAISE WARNING` below is a FORENSIC AID, NOT a
--     control: nothing in this repository reads Postgres server logs, and the
--     client library consumes async notices without surfacing them, so
--     deleting the warning would leave every test green. The layer that
--     actually refuses is the writer guard in
--     queries/projects/__tests__/function-tags-writer-guard.test.ts, which
--     fails when a writer appears outside function-tags.ts.
--
-- Same shape as the existing `audit_log_worm` guard
-- (20260702130000_audit_log_worm_tamper_evidence), minus the abort.
--
-- Deliberately BEFORE UPDATE only: a new row starts at DEFAULT 0 and there is
-- no prior version to advance, so INSERT is not covered.
--
-- OBLIGATION THIS CREATES FOR LATER MIGRATIONS: the trigger fires per row on
-- any UPDATE touching `tags` or `confirmedAt`. A future bulk update of either
-- column will therefore burn a `confirmationVersion` on every row it touches —
-- invalidating every open confirmation prompt at once — and emit one WARNING
-- per row. Such a migration must either accept that, or wrap itself in
-- ALTER TABLE ... DISABLE TRIGGER / ENABLE TRIGGER the way
-- 20260727150000_backfill_audit_log_organization does at :36 and :49, noting
-- that DISABLE takes an ACCESS EXCLUSIVE lock.
--
-- `<=`, not `<>`: a version that goes backwards is as good as one that stands
-- still for a monotonic token. A writer that DID advance it lands above this
-- threshold and the trigger leaves it untouched — there is no double bump.
CREATE OR REPLACE FUNCTION project_user_function_tag_force_version_bump()
RETURNS TRIGGER AS $$
BEGIN
  -- Invariant 1 (AC12/AC13): a write that MOVES `tags` while leaving
  -- `confirmedAt` untouched clears the confirmation. Every writer in this
  -- codebase already sets `confirmedAt` explicitly in the same statement, so
  -- this is inert for all of them. It fires for exactly one shape: a writer
  -- that predates the column — i.e. an instance of the previous app version
  -- still serving during a deploy. Without it, an admin tag edit from such an
  -- instance leaves a member permanently "confirmed" for a role they never saw.
  IF OLD."tags" IS DISTINCT FROM NEW."tags"
     AND NEW."confirmedAt" IS NOT DISTINCT FROM OLD."confirmedAt"
     AND NEW."confirmedAt" IS NOT NULL THEN
    NEW."confirmedAt" := NULL;
    RAISE WARNING
      'project_user_function_tag: a write changed tags without clearing confirmedAt; cleared it for row %',
      NEW."id";
  END IF;

  -- Invariant 2: the compare-and-set token advances whenever `tags` or
  -- `confirmedAt` change. Placed AFTER invariant 1 on purpose: clearing
  -- confirmedAt is itself a change, so the token moves with it. `<=`, not
  -- `<>`: going backwards is as good as standing still for a monotonic
  -- token. A writer that DID advance it lands above this threshold and is
  -- left alone — no double bump.
  IF (OLD."tags" IS DISTINCT FROM NEW."tags"
      OR OLD."confirmedAt" IS DISTINCT FROM NEW."confirmedAt")
     AND NEW."confirmationVersion" <= OLD."confirmationVersion" THEN
    NEW."confirmationVersion" := OLD."confirmationVersion" + 1;
    RAISE WARNING
      'project_user_function_tag: a write changed tags or confirmedAt without advancing confirmationVersion; advanced it to % for row %',
      NEW."confirmationVersion", NEW."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_user_function_tag_version_bump
  ON "project_user_function_tag";
CREATE TRIGGER project_user_function_tag_version_bump
  BEFORE UPDATE ON "project_user_function_tag"
  FOR EACH ROW EXECUTE FUNCTION project_user_function_tag_force_version_bump();
