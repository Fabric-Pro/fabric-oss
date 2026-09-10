-- Serves the daily purge scan: "which organizations are past their window?"
-- (Fizzy #2462), a predicate on `scheduledPermanentDeleteAt` alone.
--
-- Deliberately NOT partial, and the name is Prisma's default for the
-- `@@index([scheduledPermanentDeleteAt])` declared on the model. A partial index
-- would be smaller, but it cannot be expressed in schema.prisma, so the schema
-- and the database would disagree forever and every future `migrate dev` would
-- offer to "fix" it. `project` made the same call for `@@index([deletedAt])`;
-- matching it keeps one story for both soft-delete tables.
--
-- Built CONCURRENTLY so the deploy does not take a whole-table write lock on
-- `organization`, which every request touches. Single-statement migration:
-- Prisma does not wrap a lone statement in a transaction, and CONCURRENTLY
-- cannot run inside one. Nothing may be added to this file — a second statement
-- makes Prisma open a transaction and the migration fails outright.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "organization_scheduledPermanentDeleteAt_idx" ON "organization"("scheduledPermanentDeleteAt");
