-- Pull requests become time evidence: a review Fabric read of a GitHub pull
-- request whose author is a member's verified GitHub login.
--
-- ALTER TYPE ... ADD VALUE is a one-way door: it does not roll back. Safe
-- inside the migration transaction on PostgreSQL 12+, because nothing here
-- uses the new value. Additive and idempotent. No backfill.
ALTER TYPE "TimeEvidenceKind" ADD VALUE IF NOT EXISTS 'PULL_REQUEST';
