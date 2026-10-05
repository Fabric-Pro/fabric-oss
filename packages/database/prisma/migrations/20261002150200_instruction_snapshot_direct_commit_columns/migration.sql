-- AlterTable
-- The two columns of a direct commit (Fizzy #2878 §10): the frozen
-- destination and rendered commit text, and what became of the commit. Both
-- are nullable with no default and no backfill, so the statement is
-- metadata-only on the populated snapshot table and the previous app version,
-- which never reads or writes them, is unaffected. They are set only on a
-- snapshot whose proposalDestination is REPOSITORY_COMMIT.
ALTER TABLE "project_instruction_snapshot" ADD COLUMN "commitContext" JSONB,
ADD COLUMN "commitOutcome" JSONB;
