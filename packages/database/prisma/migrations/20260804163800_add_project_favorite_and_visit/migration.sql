-- Quick-access project shortcuts (#1694).
--
-- Two per-user markers on the existing per-user-per-project preference row,
-- rather than dedicated favorite and visit tables. The row is already keyed
-- uniquely on (projectId, userId) and already cascades on both project and user
-- delete, so a dedicated table would buy a second RLS registration, a second
-- tenant-db category decision and a join, for no behaviour this feature needs.
--
-- Both columns are nullable with no default, and null is meaningful rather than
-- merely absent: every row that predates this migration carries null on both,
-- and PostgreSQL sorts nulls FIRST under a plain DESC ordering. The shortcut
-- queries therefore filter `IS NOT NULL` per branch — without that, months-old
-- widget-dismissal rows would outrank real visits and the "no shortcuts for a
-- user with no history" behaviour would break in production while passing
-- against a seeded test database.
--
-- Neither column is a tenant filter. `organizationId` on this table is a
-- denormalized copy of the project's organization, written by the existing
-- writers; a guest's row on a host-organization project carries that host org
-- while the guest browses in personal context, so filtering on it would hide
-- their own row from them. Tenancy is derived from whether the related project
-- is reachable.
--
-- Expand-phase only: the previous application version simply never selects
-- these columns.

-- migration-lint: allow blocking-index — covers both CREATE INDEX statements below. The index builds run before the visit recorder's first write, so this table still holds only preference-setting rows (welcome-widget dismissals, kanban paths, saved views) and the build is short. After #1694 ships this table becomes write-hot and any later index on it must be CREATE INDEX CONCURRENTLY in its own migration.

-- AlterTable
ALTER TABLE "project_user_preference"
  ADD COLUMN "favoritedAt" TIMESTAMP(3),
  ADD COLUMN "lastVisitedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "project_user_preference_userId_lastVisitedAt_idx" ON "project_user_preference"("userId", "lastVisitedAt" DESC);

-- CreateIndex
CREATE INDEX "project_user_preference_userId_favoritedAt_idx" ON "project_user_preference"("userId", "favoritedAt" DESC);
