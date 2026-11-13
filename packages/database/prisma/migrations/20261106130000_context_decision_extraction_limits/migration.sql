-- Decision extraction reads at most a fixed number of characters of a file
-- and keeps at most a fixed number of its decisions. Each extraction now
-- records whether it met either limit, so the Decisions tab can tell a
-- reviewer that a file was only partly read.
--
-- NOT NULL with a false default: existing extractions are not backfilled,
-- because what was cut short then was not recorded. Additive and idempotent.
-- RLS is table-level, so the existing policies cover the new columns.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.

-- AlterTable
ALTER TABLE "project_context_decision_extraction" ADD COLUMN IF NOT EXISTS "contentTruncated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "project_context_decision_extraction" ADD COLUMN IF NOT EXISTS "decisionsCapped" BOOLEAN NOT NULL DEFAULT false;
