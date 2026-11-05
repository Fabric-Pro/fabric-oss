-- A rebased Coding Instructions proposal records the stale proposal it
-- replaces, and that proposal is closed only when the rebased one is READY.
--
-- Until now the stale proposal was closed in the same transaction that wrote
-- the rebased one, before its bytes were uploaded or checked. A failed upload
-- or a rejection by the checks then left the proposer with nothing pending.
-- The READY transition now closes the proposal this column names, in its own
-- transaction, and leaves it alone when it is no longer pending.
--
-- Nullable, no default, no backfill: every existing row was either never a
-- rebase or already closed its stale proposal. Not a foreign key, like
-- `baseVersion`. Additive and idempotent. RLS is table-level, so the existing
-- policies cover the new column.

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN IF NOT EXISTS "supersedesSnapshotId" TEXT;
