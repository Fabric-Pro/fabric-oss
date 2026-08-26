-- Tamper-evidence for the audit_log table (SOC 2 CC7.2 / CC7.3 — H7).

-- 1) Preserve the audit trail when an organization is deleted.
--    Previously the FK cascaded, so deleting an org wiped its entire audit
--    history ("org cascade nukes history"). SetNull keeps the rows (the
--    actor/resource/metadata snapshots retain the context); organizationId is
--    nulled on delete.
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_organizationId_fkey";
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Append-only (WORM) guard. audit_log rows are immutable:
--    * UPDATE is never permitted.
--    * DELETE is blocked unless a caller explicitly opts in for a controlled,
--      itself-auditable retention / legal-hold purge by setting
--      `SET LOCAL app.audit_allow_delete = 'on'` in the SAME transaction.
--    Row-level BEFORE trigger, so it applies to EVERY role — including the
--    table owner and superusers (triggers, unlike RLS, are not bypassed by
--    ownership). This is what makes the log tamper-evident even against a
--    compromised application DB role.
CREATE OR REPLACE FUNCTION audit_log_prevent_tampering() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The ONLY permitted UPDATE is a foreign-key ON DELETE SET NULL action:
    -- userId / organizationId / projectId may transition to NULL when their
    -- referent (user/org/project) is deleted, and NOTHING ELSE about the row
    -- may change. The content comparison uses jsonb-minus-FK-columns so it
    -- covers every current and future column automatically. Any other update
    -- (including changing an FK to a different value) is tampering.
    IF (
      (to_jsonb(NEW) - 'userId' - 'organizationId' - 'projectId')
        = (to_jsonb(OLD) - 'userId' - 'organizationId' - 'projectId')
      AND (NEW."userId" IS NOT DISTINCT FROM OLD."userId" OR NEW."userId" IS NULL)
      AND (NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId" OR NEW."organizationId" IS NULL)
      AND (NEW."projectId" IS NOT DISTINCT FROM OLD."projectId" OR NEW."projectId" IS NULL)
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only: UPDATE is not permitted';
  END IF;
  -- TG_OP = 'DELETE'
  IF current_setting('app.audit_allow_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: DELETE is not permitted (set app.audit_allow_delete = ''on'' in-transaction to purge)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_worm ON "audit_log";
CREATE TRIGGER audit_log_worm
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_tampering();
