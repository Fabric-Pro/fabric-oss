-- Backfill `audit_log.organizationId` for project-scoped rows that were written
-- without one.
--
-- WHY THESE ROWS EXIST
-- `recordAudit` set `organizationId` only when a caller passed it, and never
-- derived it from `projectId`. The organization audit log filters STRICTLY on
-- that column, so every project-scoped row whose caller forgot it was written
-- and then unreachable from the only surface anyone reads it on. The write path
-- now derives it (see `resolveAuditOrganizationId`), which stops new rows
-- landing that way; this repairs the ones already written.
--
-- WHY THIS IS SAFE AGAINST THE SEAL
-- The tamper-evidence seal covers `SEALED_AUDIT_FIELDS`, which DELIBERATELY
-- excludes `organizationId`, `userId` and `projectId` — precisely because those
-- three may legitimately transition to NULL under `ON DELETE SET NULL` and would
-- otherwise raise a false tamper alarm. So this UPDATE cannot invalidate any
-- existing seal, and it changes nothing about how future rows are sealed or
-- written. No seal needs regenerating and no verification will newly fail.
--
-- WHY THE TRIGGER IS DISABLED
-- The `audit_log_worm` trigger permits exactly one mutation to an existing row:
-- one of those three FKs moving TO NULL. This backfill moves `organizationId`
-- FROM NULL to a value, which the trigger correctly rejects as tampering.
-- Disabling it is therefore required, and is done in the narrowest form
-- available: `ALTER TABLE ... DISABLE TRIGGER` takes an ACCESS EXCLUSIVE lock,
-- so no concurrent write can slip past the guard while it is off, and the whole
-- migration runs in one transaction — if the UPDATE fails, the trigger is
-- restored by the rollback rather than left off.
--
-- A PERMANENT GUC BYPASS WAS DELIBERATELY NOT ADDED. A standing "you may edit
-- audit rows" escape hatch is a much larger hole than a one-off, reviewable
-- migration, and nothing else needs it.
--
-- Authorised as a one-off by the product owner, 2026-07-27.

ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_worm";

-- Only rows that are unambiguously repairable: a project is still attached, the
-- organization is currently missing, and that project genuinely belongs to an
-- organization. A personal-context project has no organization, so its rows are
-- left alone — NULL is the correct value there, not a gap.
UPDATE "audit_log" AS a
SET "organizationId" = p."organizationId"
FROM "project" AS p
WHERE a."projectId" = p."id"
  AND a."organizationId" IS NULL
  AND p."organizationId" IS NOT NULL;

ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_worm";
