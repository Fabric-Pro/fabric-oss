-- Tenant-configurable attachment retention (#1749).
--
-- The CHECK constraints make an unusable value UNREPRESENTABLE rather than
-- merely sanitized on read: zod guards only the API path, and a seed, a
-- restore, a migration or psql does not pass through it. A single out-of-range
-- row would otherwise distort the purge's global scan bound.

ALTER TABLE "organization"
  ADD COLUMN "attachmentRetentionDays" INTEGER,
  ADD COLUMN "attachmentRetentionDaysUpdatedAt" TIMESTAMP(3);

ALTER TABLE "project"
  ADD COLUMN "attachmentRetentionDays" INTEGER,
  ADD COLUMN "attachmentRetentionDaysUpdatedAt" TIMESTAMP(3);

-- migration-lint: allow unvalidated-constraint — the column is added in this
-- same migration, so every existing row is NULL and the check is trivially
-- satisfied; there is no back-scan to defer.
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_attachmentRetentionDays_range"
  CHECK ("attachmentRetentionDays" IS NULL
         OR "attachmentRetentionDays" BETWEEN 30 AND 3650);

-- migration-lint: allow unvalidated-constraint — same reasoning.
ALTER TABLE "project"
  ADD CONSTRAINT "project_attachmentRetentionDays_range"
  CHECK ("attachmentRetentionDays" IS NULL
         OR "attachmentRetentionDays" BETWEEN 30 AND 3650);

-- Partial indexes: the purge takes MIN() over these columns once per run.
-- Overrides are rare, so a partial index turns two sequential scans of
-- `project` and `organization` into index-only scans of a handful of rows.
-- migration-lint: allow blocking-index — partial index over a column added in
-- this migration, so it covers zero rows and builds instantly.
CREATE INDEX "organization_attachmentRetentionDays_idx"
  ON "organization" ("attachmentRetentionDays")
  WHERE "attachmentRetentionDays" IS NOT NULL;

-- migration-lint: allow blocking-index — same reasoning.
CREATE INDEX "project_attachmentRetentionDays_idx"
  ON "project" ("attachmentRetentionDays")
  WHERE "attachmentRetentionDays" IS NOT NULL;
