-- When a reader last looked at one CONTENT TYPE on a topic, so a generation tab
-- can say a draft has changed since they were last there.
--
-- A separate table from `publishing_topic_read` rather than a column on it:
-- that row means "this topic has been opened" and unreading DELETES it, so
-- adding a post type would change what its absence means and break the
-- one-row-per-reader shape the Inbox's unread dot depends on.
--
-- The constraint that shaped both tables: neither may touch `publishing_topic`.
-- Reading must not bump a topic's `updatedAt`, or opening one would reorder
-- "Recently Modified" underneath the person reading it.
CREATE TABLE "publishing_topic_draft_read" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postType" "publishing_topic_post_type" NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publishing_topic_draft_read_pkey" PRIMARY KEY ("id")
);

-- The unique index IS the upsert's conflict target, so it ships with the table
-- rather than concurrently: an empty table has nothing for a blocking build to
-- block.
CREATE UNIQUE INDEX "publishing_topic_draft_read_topicId_userId_postType_key"
    ON "publishing_topic_draft_read"("topicId", "userId", "postType");
CREATE INDEX "publishing_topic_draft_read_userId_projectId_idx"
    ON "publishing_topic_draft_read"("userId", "projectId");
CREATE INDEX "publishing_topic_draft_read_organizationId_idx"
    ON "publishing_topic_draft_read"("organizationId");

ALTER TABLE "publishing_topic_draft_read"
    ADD CONSTRAINT "publishing_topic_draft_read_topicId_fkey"
    FOREIGN KEY ("topicId") REFERENCES "publishing_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_draft_read"
    ADD CONSTRAINT "publishing_topic_draft_read_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_draft_read"
    ADD CONSTRAINT "publishing_topic_draft_read_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
