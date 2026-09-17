-- Versioned history for a topic's working DRAFT body, per content type.
--
-- `publishing_topic_working_draft` is ONE upserted row per (topicId, postType),
-- so every hand save overwrote the last: manual edits were versioned nowhere,
-- and restoring an earlier version discarded them with only a confirm dialog
-- standing in for a history. Nothing could be projected back at read time — the
-- rows were never written. This table is where they go from now on.
--
-- The exact sibling of `publishing_topic_analysis_revision` one level down, and
-- deliberately shaped like it: same tenant XOR, same composite FK, same
-- author-is-not-tenancy split, same append-only discipline. A reviewer who
-- knows that table should not have to learn a second set of conventions.
--
-- Starts EMPTY. No backfill is possible and none is wanted: the prior bodies a
-- backfill would invent were never recorded, and inventing them would put words
-- in an author's mouth. Existing topics simply begin their history at their next
-- save.
CREATE TYPE "PublishingDraftRevisionKind" AS ENUM ('EDITED', 'RESTORED');

CREATE TABLE "publishing_topic_draft_revision" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "postType" "PublishingTopicPostType" NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "kind" "PublishingDraftRevisionKind" NOT NULL,
    "sourceDraftVersion" INTEGER,
    "authorUserId" TEXT,
    "changeSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publishing_topic_draft_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publishing_topic_draft_revision_topicId_postType_version_key" ON "publishing_topic_draft_revision"("topicId", "postType", "version");
CREATE INDEX "publishing_topic_draft_revision_topicId_postType_createdAt_idx" ON "publishing_topic_draft_revision"("topicId", "postType", "createdAt");
CREATE INDEX "publishing_topic_draft_revision_projectId_idx" ON "publishing_topic_draft_revision"("projectId");
CREATE INDEX "publishing_topic_draft_revision_organizationId_idx" ON "publishing_topic_draft_revision"("organizationId");
CREATE INDEX "publishing_topic_draft_revision_userId_idx" ON "publishing_topic_draft_revision"("userId");
CREATE INDEX "publishing_topic_draft_revision_authorUserId_idx" ON "publishing_topic_draft_revision"("authorUserId");

-- AddForeignKey
ALTER TABLE "publishing_topic_draft_revision" ADD CONSTRAINT "publishing_topic_draft_revision_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "publishing_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_draft_revision" ADD CONSTRAINT "publishing_topic_draft_revision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_draft_revision" ADD CONSTRAINT "publishing_topic_draft_revision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_draft_revision" ADD CONSTRAINT "publishing_topic_draft_revision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_draft_revision" ADD CONSTRAINT "publishing_topic_draft_revision_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Composite FK: the two ids must AGREE, not merely both exist.
-- The referenced pair already carries UNIQUE "publishing_topic_id_project_key",
-- added by 20260901120000_add_publishing_topic_drafts:193. Do NOT re-create it —
-- Postgres rejects a duplicate constraint name and the whole migration aborts.
-- Postgres accepts a composite FK only against a unique referenced column list,
-- which is why that constraint exists at all.
ALTER TABLE "publishing_topic_draft_revision" ADD CONSTRAINT "publishing_topic_draft_revision_topic_project_fkey" FOREIGN KEY ("topicId", "projectId") REFERENCES "publishing_topic"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant XOR. RLS does not substitute: its org branch permits any userId.
ALTER TABLE "publishing_topic_draft_revision" ADD CONSTRAINT "publishing_topic_draft_revision_tenant_xor" CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));
