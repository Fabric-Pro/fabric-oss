-- AlterEnum: Add NEEDS_REVISION to WeavePlanStatus
-- Note: ALTER TYPE ... ADD VALUE is not reversible inside a transaction.
-- Rollback requires: CREATE TYPE replacement or manual enum management.
-- See: https://www.postgresql.org/docs/current/sql-altertype.html
ALTER TYPE "WeavePlanStatus" ADD VALUE 'NEEDS_REVISION';

-- Drop default on checkboxes (empty array default removed in schema)
ALTER TABLE "weave_plan" ALTER COLUMN "checkboxes" DROP DEFAULT;
