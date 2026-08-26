-- Add comment threads for project features and tasks, including Fabric Agent replies.

CREATE TYPE "project_comment_author_type" AS ENUM ('USER', 'AGENT');

CREATE TABLE "user_story_comment" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorType" "project_comment_author_type" NOT NULL DEFAULT 'USER',
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "sourceCommentId" TEXT,
    "workflowId" TEXT,
    "metadata" JSONB,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "user_story_comment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "story_task_comment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorType" "project_comment_author_type" NOT NULL DEFAULT 'USER',
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "sourceCommentId" TEXT,
    "workflowId" TEXT,
    "metadata" JSONB,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "story_task_comment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_story_comment_storyId_createdAt_idx" ON "user_story_comment"("storyId", "createdAt");
CREATE INDEX "user_story_comment_authorId_idx" ON "user_story_comment"("authorId");
CREATE INDEX "user_story_comment_authorType_idx" ON "user_story_comment"("authorType");
CREATE INDEX "user_story_comment_parentId_idx" ON "user_story_comment"("parentId");
CREATE INDEX "user_story_comment_sourceCommentId_idx" ON "user_story_comment"("sourceCommentId");
CREATE INDEX "user_story_comment_organizationId_idx" ON "user_story_comment"("organizationId");

CREATE INDEX "story_task_comment_taskId_createdAt_idx" ON "story_task_comment"("taskId", "createdAt");
CREATE INDEX "story_task_comment_authorId_idx" ON "story_task_comment"("authorId");
CREATE INDEX "story_task_comment_authorType_idx" ON "story_task_comment"("authorType");
CREATE INDEX "story_task_comment_parentId_idx" ON "story_task_comment"("parentId");
CREATE INDEX "story_task_comment_sourceCommentId_idx" ON "story_task_comment"("sourceCommentId");
CREATE INDEX "story_task_comment_organizationId_idx" ON "story_task_comment"("organizationId");

ALTER TABLE "user_story_comment" ADD CONSTRAINT "user_story_comment_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_story_comment" ADD CONSTRAINT "user_story_comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "user_story_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_story_comment" ADD CONSTRAINT "user_story_comment_sourceCommentId_fkey" FOREIGN KEY ("sourceCommentId") REFERENCES "user_story_comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "user_story_comment" ADD CONSTRAINT "user_story_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_story_comment" ADD CONSTRAINT "user_story_comment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "story_task_comment" ADD CONSTRAINT "story_task_comment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "story_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_task_comment" ADD CONSTRAINT "story_task_comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "story_task_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_task_comment" ADD CONSTRAINT "story_task_comment_sourceCommentId_fkey" FOREIGN KEY ("sourceCommentId") REFERENCES "story_task_comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "story_task_comment" ADD CONSTRAINT "story_task_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_task_comment" ADD CONSTRAINT "story_task_comment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
