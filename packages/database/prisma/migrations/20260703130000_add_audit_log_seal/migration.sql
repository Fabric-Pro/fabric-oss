-- Tamper-evidence seal chain for the append-only audit_log (SOC 2 CC7.1/CC7.2).
-- Each row is a periodic, chained, HMAC-signed cryptographic seal over the
-- immutable content of the audit_log rows in a time window. See
-- packages/database/prisma/queries/audit-log-seal.ts.

-- CreateTable
CREATE TABLE "audit_log_seal" (
    "id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "prevSealHash" TEXT,
    "sealHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_seal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_seal_sequence_key" ON "audit_log_seal"("sequence");

-- CreateIndex
CREATE INDEX "audit_log_seal_periodEnd_idx" ON "audit_log_seal"("periodEnd");

-- Append-only (WORM) guard for the seal chain itself. The seals ARE the
-- tamper-evidence anchor, so they must be at least as immutable as the log they
-- protect:
--   * UPDATE is NEVER permitted (unlike audit_log, the seal table has no
--     nullable foreign keys, so there is no legitimate in-place mutation).
--   * DELETE is blocked unless a caller explicitly opts in for a controlled,
--     itself-auditable purge by setting `SET LOCAL app.audit_seal_allow_delete
--     = 'on'` in the SAME transaction (e.g. pruning seals whose covered
--     audit_log rows were already purged by retention).
-- Row-level BEFORE trigger so it binds every role including the table owner and
-- superusers (triggers, unlike RLS, are not bypassed by ownership) — which is
-- exactly what makes the chain tamper-evident against a compromised DB role.
CREATE OR REPLACE FUNCTION audit_log_seal_prevent_tampering() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log_seal is append-only: UPDATE is not permitted';
  END IF;
  -- TG_OP = 'DELETE'
  IF current_setting('app.audit_seal_allow_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log_seal is append-only: DELETE is not permitted (set app.audit_seal_allow_delete = ''on'' in-transaction to purge)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_seal_worm ON "audit_log_seal";
CREATE TRIGGER audit_log_seal_worm
  BEFORE UPDATE OR DELETE ON "audit_log_seal"
  FOR EACH ROW EXECUTE FUNCTION audit_log_seal_prevent_tampering();
