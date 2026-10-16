-- What a published page keeps between visits, and who may read a Fabric Agent
-- session.
--
-- 1. "frame_page_record": one row per (page, collection, owner, key). A page is
--    an "agent_workspace_file" row, whose path is unique per creator, so a
--    shared record cannot live on it without splitting into one row per
--    viewer. "ownerUserId" is '' for a record every viewer shares and the
--    writer's user id for one only that person sees; it is part of the unique
--    key because Postgres does not treat NULLs as equal there. The table is
--    new, so it is indexed here at no cost and nothing is backfilled. Rows go
--    with their page (ON DELETE CASCADE).
--
-- 2. "agent_conversation"."visibility": PRIVATE keeps every existing session
--    readable by its owner only, exactly as before; ORGANIZATION lets the
--    organization read the transcript. NOT NULL with a constant default is a
--    metadata-only change on current Postgres, so there is no table rewrite
--    and the previous app version, which never writes the column, keeps
--    working. Its supporting index is the next migration, built CONCURRENTLY.
--
-- RLS is applied out of band by `pnpm --filter @repo/database apply:rls`. The
-- registrations are in `scripts/apply-rls-direct.ts` ("org_only" for the
-- records; "per_user_within_org_shared_read" for the session) and are matched
-- by `src/tenant-db.ts`, or the table fails OPEN on the tenant path.
-- Dropping the table, the column and the enum undoes the migration.

-- CreateEnum
CREATE TYPE "AgentConversationVisibility" AS ENUM ('PRIVATE', 'ORGANIZATION');

-- AlterTable
ALTER TABLE "agent_conversation" ADD COLUMN     "visibility" "AgentConversationVisibility" NOT NULL DEFAULT 'PRIVATE';

-- CreateTable
CREATE TABLE "frame_page_record" (
    "id" TEXT NOT NULL,
    "frameId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL DEFAULT '',
    "value" JSONB NOT NULL,
    "size" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "frame_page_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "frame_page_record_frameId_collection_createdAt_idx" ON "frame_page_record"("frameId", "collection", "createdAt");

-- CreateIndex
CREATE INDEX "frame_page_record_organizationId_idx" ON "frame_page_record"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "frame_page_record_frameId_collection_ownerUserId_key_key" ON "frame_page_record"("frameId", "collection", "ownerUserId", "key");

-- AddForeignKey
ALTER TABLE "frame_page_record" ADD CONSTRAINT "frame_page_record_frameId_fkey" FOREIGN KEY ("frameId") REFERENCES "agent_workspace_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;
