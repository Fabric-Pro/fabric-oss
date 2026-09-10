-- Resolving which workspace a session runs in asks the member table "where does
-- this person belong" — a predicate supplying only userId. The existing unique
-- index leads with organizationId and cannot serve it, so the lookup read every
-- member row on the platform. That scan is not new; what changed is that Fizzy
-- #2403 moved the resolution onto the session-creation path, so a cost paid
-- after the response was sent now sits in front of every sign-in.
--
-- Stated here rather than pointed at: a migration is a permanent record, and
-- schema.prisma's copy of this reasoning is a live file that can be reworded or
-- dropped as the model evolves.
--
-- Built CONCURRENTLY so the deploy does not take a whole-table write lock.
-- Single-statement migration: Prisma does not wrap a lone statement in a
-- transaction, and CONCURRENTLY cannot run inside one.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "member_user_idx" ON "member"("userId");
