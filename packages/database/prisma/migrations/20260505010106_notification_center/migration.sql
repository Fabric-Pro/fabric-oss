-- Notification center: per-recipient persistent inbox.
-- Tenant-scoped via XOR (organizationId is null for personal context).

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('MENTION', 'REPLY', 'ASSIGNMENT', 'STATUS', 'AGENT', 'PROJECT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('STORY_MENTION', 'STORY_COMMENT_REPLY', 'STORY_ASSIGNED', 'TASK_MENTION', 'TASK_COMMENT_REPLY', 'COMMENT_MENTION', 'AGENT_REPLY_READY');

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "type" "NotificationType" NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "snippet" TEXT,
    "link" TEXT,
    "iconKey" TEXT,
    "projectId" TEXT,
    "storyId" TEXT,
    "taskId" TEXT,
    "commentId" TEXT,
    "documentId" TEXT,
    "actorUserId" TEXT,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (hottest query: user's unread for active scope, paginated DESC)
CREATE INDEX "notification_userId_organizationId_readAt_createdAt_idx" ON "notification"("userId", "organizationId", "readAt", "createdAt" DESC);
CREATE INDEX "notification_userId_organizationId_category_createdAt_idx" ON "notification"("userId", "organizationId", "category", "createdAt" DESC);
CREATE INDEX "notification_projectId_idx" ON "notification"("projectId");
CREATE INDEX "notification_storyId_idx" ON "notification"("storyId");
CREATE INDEX "notification_commentId_idx" ON "notification"("commentId");
CREATE INDEX "notification_userId_dedupeKey_createdAt_idx" ON "notification"("userId", "dedupeKey", "createdAt");

-- Partial unique index that backs the dedup upsert. Two near-simultaneous
-- writers with the same (userId, dedupeKey) collapse into one row instead of
-- racing past the find-then-update window.
CREATE UNIQUE INDEX "notification_userId_dedupeKey_unread_uq"
    ON "notification"("userId", "dedupeKey")
    WHERE "readAt" IS NULL AND "dedupeKey" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification" ADD CONSTRAINT "notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification" ADD CONSTRAINT "notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification" ADD CONSTRAINT "notification_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security: a user can only see their own notifications.
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notification_owner_isolation" ON "notification"
    USING ("userId" = current_setting('app.user_id', true));
