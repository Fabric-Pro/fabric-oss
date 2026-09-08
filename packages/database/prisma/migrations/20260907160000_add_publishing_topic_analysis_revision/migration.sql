-- CreateTable
CREATE TABLE "publishing_topic_analysis_revision" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "sourceAnalysisVersion" INTEGER NOT NULL,
    "authorUserId" TEXT,
    "changeSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publishing_topic_analysis_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publishing_topic_analysis_revision_topicId_version_key" ON "publishing_topic_analysis_revision"("topicId", "version");
CREATE INDEX "publishing_topic_analysis_revision_topicId_createdAt_idx" ON "publishing_topic_analysis_revision"("topicId", "createdAt");
CREATE INDEX "publishing_topic_analysis_revision_projectId_idx" ON "publishing_topic_analysis_revision"("projectId");
CREATE INDEX "publishing_topic_analysis_revision_organizationId_idx" ON "publishing_topic_analysis_revision"("organizationId");
CREATE INDEX "publishing_topic_analysis_revision_userId_idx" ON "publishing_topic_analysis_revision"("userId");
CREATE INDEX "publishing_topic_analysis_revision_authorUserId_idx" ON "publishing_topic_analysis_revision"("authorUserId");

-- AddForeignKey
ALTER TABLE "publishing_topic_analysis_revision" ADD CONSTRAINT "publishing_topic_analysis_revision_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "publishing_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_analysis_revision" ADD CONSTRAINT "publishing_topic_analysis_revision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_analysis_revision" ADD CONSTRAINT "publishing_topic_analysis_revision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_analysis_revision" ADD CONSTRAINT "publishing_topic_analysis_revision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_topic_analysis_revision" ADD CONSTRAINT "publishing_topic_analysis_revision_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Composite FK: the two ids must AGREE, not merely both exist.
-- The referenced pair already carries UNIQUE "publishing_topic_id_project_key",
-- added by 20260901120000_add_publishing_topic_drafts:193. Do NOT re-create it —
-- Postgres rejects a duplicate constraint name and the whole migration aborts.
-- Postgres accepts a composite FK only against a unique referenced column list,
-- which is why that constraint exists at all.
ALTER TABLE "publishing_topic_analysis_revision" ADD CONSTRAINT "publishing_topic_analysis_revision_topic_project_fkey" FOREIGN KEY ("topicId", "projectId") REFERENCES "publishing_topic"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant XOR. RLS does not substitute: its org branch permits any userId.
ALTER TABLE "publishing_topic_analysis_revision" ADD CONSTRAINT "publishing_topic_analysis_revision_tenant_xor" CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));
