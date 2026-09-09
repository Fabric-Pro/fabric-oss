-- One reader's Inbox preferences for one project: how the list is sorted and
-- laid out.
--
-- Per user AND per project, matching how project tab customization already
-- stores a member's layout. Both columns carry defaults, so a reader with no
-- row is not a special case anywhere — the absence of a row and the default
-- preference are the same thing, and nothing has to backfill.
--
-- Deliberately not on `publishing_suite_settings`, which is the project's own
-- admin-owned configuration. A personal preference must not need permission.
CREATE TYPE "publishing_list_sort" AS ENUM ('RECOMMENDED', 'RECENTLY_UPDATED', 'RECENTLY_CREATED');
CREATE TYPE "publishing_list_view" AS ENUM ('LIST', 'TWO_COLUMN');

CREATE TABLE "publishing_list_preference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    -- Denormalized from the parent project, never from ambient context: every
    -- tenant policy in apply-rls-direct.ts reads this column, so a row without
    -- it is a row RLS cannot place. Null in personal context.
    "organizationId" TEXT,
    "sort" "publishing_list_sort" NOT NULL DEFAULT 'RECOMMENDED',
    "view" "publishing_list_view" NOT NULL DEFAULT 'LIST',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishing_list_preference_pkey" PRIMARY KEY ("id")
);

-- The unique index IS the upsert's conflict target, so it ships in the same
-- migration as the table rather than concurrently: there are no rows yet, so
-- there is nothing for a blocking build to block.
CREATE UNIQUE INDEX "publishing_list_preference_userId_projectId_key"
    ON "publishing_list_preference"("userId", "projectId");

ALTER TABLE "publishing_list_preference"
    ADD CONSTRAINT "publishing_list_preference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_list_preference"
    ADD CONSTRAINT "publishing_list_preference_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_list_preference"
    ADD CONSTRAINT "publishing_list_preference_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "publishing_list_preference_organizationId_idx"
    ON "publishing_list_preference"("organizationId");
