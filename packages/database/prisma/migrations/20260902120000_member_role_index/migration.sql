-- Editing a universal (SYSTEM-tier) default prompt asks the member table "who
-- administers anything, anywhere" — a predicate with no organization to narrow
-- it, so it read every row on the platform once per action the prompt wins.
-- Built CONCURRENTLY so the deploy does not take a whole-table write lock.
-- Single-statement migration: Prisma does not wrap a lone statement in a
-- transaction, and CONCURRENTLY cannot run inside one.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "member_role_idx" ON "member"("role");
