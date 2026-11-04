-- A native repository proposal may now change a file that exists only on the
-- member's own proposal branch: delete it, or edit it. Such an entry records
-- the blob Fabric wrote on that branch in `branchObjectId`. Nullable, no
-- default, no backfill and no index: every existing entry is relative to the
-- published version, which is what null means, and the previous app version
-- never reads or writes the column.

-- AlterTable
ALTER TABLE "project_instruction_git_intent_entry" ADD COLUMN IF NOT EXISTS "branchObjectId" TEXT;
