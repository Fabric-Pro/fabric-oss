-- Moving AI files out of a code repository: the plan files the person kept
-- in the code repository (files that ship with the product, such as the
-- skills of the repository's own coding-tool plugin), so a later move does
-- not offer them for moving again.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change. Additive: a NOT NULL array column with a constant
-- default is a metadata-only change on Postgres 11+, so existing rows read as
-- an empty list without a table rewrite.
--
-- Tenancy: unchanged; the row keeps its project-copied userId/organizationId
-- and its existing RLS policy.

ALTER TABLE "instruction_consolidation"
  ADD COLUMN "keptPaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
