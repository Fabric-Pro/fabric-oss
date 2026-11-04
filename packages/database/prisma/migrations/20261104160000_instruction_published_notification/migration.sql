-- Tell a project's members when a new Coding Instructions version is
-- published, once per snapshot.
--
-- A distinct notification type: the row renderer and the bell's filters key
-- off the type. Category PROJECT, which already maps to the `syncProject`
-- preference toggle, so no new setting is needed.
--
-- `publishNotifiedAt` is the at-most-once claim (`UPDATE ... WHERE
-- "publishNotifiedAt" IS NULL`). `publishedAt` cannot serve, because a
-- rollback to a version overwrites it. No backfill: a version published
-- before this column existed was never announced, so a later rollback to it
-- announces it once, like any version published for the first time.
--
-- ALTER TYPE ... ADD VALUE is a one-way door: it does not roll back. Safe
-- inside the migration transaction on PostgreSQL 12+, because nothing here
-- uses the new value. Additive and idempotent.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CODING_INSTRUCTIONS_PUBLISHED';

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN IF NOT EXISTS "publishNotifiedAt" TIMESTAMP(3);
