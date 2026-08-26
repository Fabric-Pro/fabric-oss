-- CreateTable
CREATE TABLE "daily_brief" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeWindowStart" TIMESTAMP(3) NOT NULL,
    "timeWindowEnd" TIMESTAMP(3) NOT NULL,
    "timeWindowKind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "content" JSONB,
    "errorMessage" TEXT,
    "generatedByUserId" TEXT NOT NULL,
    "temporalWorkflowId" TEXT,
    "aiUsageTokens" INTEGER,

    CONSTRAINT "daily_brief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_brief_view" (
    "id" TEXT NOT NULL,
    "dailyBriefId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_brief_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_brief_cursor" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "lastReviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_brief_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_brief_projectId_generatedAt_idx" ON "daily_brief"("projectId", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "daily_brief_projectId_status_idx" ON "daily_brief"("projectId", "status");

-- CreateIndex
CREATE INDEX "daily_brief_organizationId_idx" ON "daily_brief"("organizationId");

-- CreateIndex
CREATE INDEX "daily_brief_userId_idx" ON "daily_brief"("userId");

-- CreateIndex
CREATE INDEX "daily_brief_generatedByUserId_idx" ON "daily_brief"("generatedByUserId");

-- CreateIndex
CREATE INDEX "daily_brief_view_userId_idx" ON "daily_brief_view"("userId");

-- CreateIndex
CREATE INDEX "daily_brief_view_organizationId_idx" ON "daily_brief_view"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_brief_view_dailyBriefId_userId_key" ON "daily_brief_view"("dailyBriefId", "userId");

-- CreateIndex
CREATE INDEX "project_brief_cursor_projectId_idx" ON "project_brief_cursor"("projectId");

-- CreateIndex
CREATE INDEX "project_brief_cursor_userId_idx" ON "project_brief_cursor"("userId");

-- CreateIndex
CREATE INDEX "project_brief_cursor_organizationId_idx" ON "project_brief_cursor"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_brief_cursor_projectId_userId_key" ON "project_brief_cursor"("projectId", "userId");

-- Partial unique index: prevents parallel in-flight regenerate workflows for the same (project, window).
-- A second regenerate call during generation will hit this constraint and must be handled by the oRPC
-- procedure (read back the existing row and return its briefId/workflowId instead of creating a new one).
CREATE UNIQUE INDEX "daily_brief_active_regen" ON "daily_brief"("projectId", "timeWindowKind") WHERE "status" = 'GENERATING';

-- AddForeignKey
ALTER TABLE "daily_brief" ADD CONSTRAINT "daily_brief_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_brief" ADD CONSTRAINT "daily_brief_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_brief" ADD CONSTRAINT "daily_brief_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_brief" ADD CONSTRAINT "daily_brief_generatedByUserId_fkey" FOREIGN KEY ("generatedByUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_brief_view" ADD CONSTRAINT "daily_brief_view_dailyBriefId_fkey" FOREIGN KEY ("dailyBriefId") REFERENCES "daily_brief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_brief_view" ADD CONSTRAINT "daily_brief_view_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_brief_view" ADD CONSTRAINT "daily_brief_view_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_brief_cursor" ADD CONSTRAINT "project_brief_cursor_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_brief_cursor" ADD CONSTRAINT "project_brief_cursor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_brief_cursor" ADD CONSTRAINT "project_brief_cursor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
