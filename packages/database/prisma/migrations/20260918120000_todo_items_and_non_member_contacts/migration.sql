-- Consolidated To Do list: durable to-do rows and the non-member contact
-- register (Fizzy #2340).
--
-- Trimmed by hand from a generated diff. The generator also emitted index
-- renames, index drops and constraint drops belonging to other work that has
-- accumulated in the schema; none of that is this change and none of it is
-- here. A clean generated run would have been the surprise, not the norm.
--
-- `todo_item` binds to a meeting action item by (transcriptId, itemKey,
-- occurrenceIndex) rather than by the action item's row id, because extraction
-- deletes and recreates those rows on every run. NULLs do not collide in
-- Postgres, so a manually created to-do — which carries none of those three —
-- is unconstrained by that unique index.
--
-- `itemKey` on project_meeting_action_item is nullable with no default, so
-- adding it takes no table rewrite and no backfill; the existing row builder
-- populates it from the same helper going forward. Its index is built
-- CONCURRENTLY in the migration beside this one, because that table is not
-- empty.
--
-- RLS is applied out of band by `pnpm --filter @repo/database apply:rls`; the
-- registrations are in `scripts/apply-rls-direct.ts` (`org_only_owned` for
-- non_member_contact, which has no owning user, and `user_owned` for todo_item)
-- and must be matched by `src/tenant-db.ts`, or a table fails OPEN on the
-- tenant path.

-- CreateEnum
CREATE TYPE "todo_item_source" AS ENUM ('MEETING_DIGEST', 'MANUAL');

-- AlterTable
ALTER TABLE "project_meeting_action_item" ADD COLUMN     "itemKey" TEXT;

-- CreateTable
CREATE TABLE "non_member_contact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "company" TEXT,
    "redactedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "non_member_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "todo_item" (
    "id" TEXT NOT NULL,
    "source" "todo_item_source" NOT NULL,
    "transcriptId" TEXT,
    "itemKey" TEXT,
    "occurrenceIndex" INTEGER,
    "itemTextSnapshot" TEXT,
    "title" TEXT,
    "projectId" TEXT,
    "assigneeUserId" TEXT,
    "assigneeContactId" TEXT,
    "suggestedUserId" TEXT,
    "suggestedContactId" TEXT,
    "suggestionCandidates" JSONB,
    "assignedManually" BOOLEAN NOT NULL DEFAULT false,
    "snoozedUntil" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "lastKnownCompletedAt" TIMESTAMP(3),
    "sourceDate" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "todo_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "non_member_contact_organizationId_idx" ON "non_member_contact"("organizationId");

-- CreateIndex
CREATE INDEX "todo_item_organizationId_assigneeUserId_idx" ON "todo_item"("organizationId", "assigneeUserId");

-- CreateIndex
CREATE INDEX "todo_item_organizationId_assigneeContactId_idx" ON "todo_item"("organizationId", "assigneeContactId");

-- CreateIndex
CREATE INDEX "todo_item_organizationId_sourceDate_idx" ON "todo_item"("organizationId", "sourceDate");

-- CreateIndex
CREATE INDEX "todo_item_projectId_idx" ON "todo_item"("projectId");

-- CreateIndex
CREATE INDEX "todo_item_transcriptId_idx" ON "todo_item"("transcriptId");

-- CreateIndex
CREATE INDEX "todo_item_userId_idx" ON "todo_item"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "todo_item_transcriptId_itemKey_occurrenceIndex_key" ON "todo_item"("transcriptId", "itemKey", "occurrenceIndex");

-- AddForeignKey
ALTER TABLE "non_member_contact" ADD CONSTRAINT "non_member_contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "todo_item" ADD CONSTRAINT "todo_item_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "project_meeting_transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "todo_item" ADD CONSTRAINT "todo_item_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "todo_item" ADD CONSTRAINT "todo_item_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "todo_item" ADD CONSTRAINT "todo_item_assigneeContactId_fkey" FOREIGN KEY ("assigneeContactId") REFERENCES "non_member_contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
