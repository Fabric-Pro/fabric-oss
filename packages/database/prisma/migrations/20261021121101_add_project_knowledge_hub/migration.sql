-- CreateEnum
CREATE TYPE "KnowledgeSummaryBehavior" AS ENUM ('MERGE', 'LATEST_WINS', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "KnowledgeVisibility" AS ENUM ('MEMBERS', 'MEMBERS_AND_GUESTS');

-- CreateEnum
CREATE TYPE "KnowledgeTopicKind" AS ENUM ('WORK_ITEM', 'FREE');

-- CreateEnum
CREATE TYPE "KnowledgeTopicSummaryStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "knowledge_artifact_type" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "template" TEXT,
    "fieldSchema" JSONB,
    "summaryBehavior" "KnowledgeSummaryBehavior" NOT NULL DEFAULT 'MERGE',
    "visibility" "KnowledgeVisibility" NOT NULL DEFAULT 'MEMBERS',
    "retentionDays" INTEGER,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "updatedByUserId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_artifact_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_topic" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "KnowledgeTopicKind" NOT NULL,
    "userStoryId" TEXT,
    "externalRef" TEXT,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "lastEntryAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "agentClient" TEXT,
    "role" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fields" JSONB,
    "contentHash" TEXT NOT NULL,
    "supersedesId" TEXT,
    "qdrantId" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_topic_summary" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "KnowledgeTopicSummaryStatus" NOT NULL DEFAULT 'PENDING',
    "content" TEXT,
    "coveredThrough" TIMESTAMP(3),
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "references" JSONB,
    "model" TEXT,
    "error" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_topic_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_artifact_type_userId_idx" ON "knowledge_artifact_type"("userId");

-- CreateIndex
CREATE INDEX "knowledge_artifact_type_organizationId_idx" ON "knowledge_artifact_type"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_artifact_type_projectId_key_key" ON "knowledge_artifact_type"("projectId", "key");

-- CreateIndex
CREATE INDEX "knowledge_topic_projectId_lastEntryAt_idx" ON "knowledge_topic"("projectId", "lastEntryAt");

-- CreateIndex
CREATE INDEX "knowledge_topic_userStoryId_idx" ON "knowledge_topic"("userStoryId");

-- CreateIndex
CREATE INDEX "knowledge_topic_userId_idx" ON "knowledge_topic"("userId");

-- CreateIndex
CREATE INDEX "knowledge_topic_organizationId_idx" ON "knowledge_topic"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_topic_projectId_key_key" ON "knowledge_topic"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entry_supersedesId_key" ON "knowledge_entry"("supersedesId");

-- CreateIndex
CREATE INDEX "knowledge_entry_topicId_createdAt_idx" ON "knowledge_entry"("topicId", "createdAt");

-- CreateIndex
CREATE INDEX "knowledge_entry_projectId_createdAt_idx" ON "knowledge_entry"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "knowledge_entry_typeId_idx" ON "knowledge_entry"("typeId");

-- CreateIndex
CREATE INDEX "knowledge_entry_authorUserId_idx" ON "knowledge_entry"("authorUserId");

-- CreateIndex
CREATE INDEX "knowledge_entry_userId_idx" ON "knowledge_entry"("userId");

-- CreateIndex
CREATE INDEX "knowledge_entry_organizationId_idx" ON "knowledge_entry"("organizationId");

-- CreateIndex
CREATE INDEX "knowledge_topic_summary_topicId_createdAt_idx" ON "knowledge_topic_summary"("topicId", "createdAt");

-- CreateIndex
CREATE INDEX "knowledge_topic_summary_projectId_idx" ON "knowledge_topic_summary"("projectId");

-- CreateIndex
CREATE INDEX "knowledge_topic_summary_userId_idx" ON "knowledge_topic_summary"("userId");

-- CreateIndex
CREATE INDEX "knowledge_topic_summary_organizationId_idx" ON "knowledge_topic_summary"("organizationId");

-- AddForeignKey
ALTER TABLE "knowledge_artifact_type" ADD CONSTRAINT "knowledge_artifact_type_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_topic" ADD CONSTRAINT "knowledge_topic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_topic" ADD CONSTRAINT "knowledge_topic_userStoryId_fkey" FOREIGN KEY ("userStoryId") REFERENCES "user_story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry" ADD CONSTRAINT "knowledge_entry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry" ADD CONSTRAINT "knowledge_entry_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "knowledge_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry" ADD CONSTRAINT "knowledge_entry_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "knowledge_artifact_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry" ADD CONSTRAINT "knowledge_entry_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "knowledge_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_topic_summary" ADD CONSTRAINT "knowledge_topic_summary_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "knowledge_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_topic_summary" ADD CONSTRAINT "knowledge_topic_summary_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
