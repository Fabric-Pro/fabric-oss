-- AlterTable
ALTER TABLE "project" ADD COLUMN "notionPrdContextId" TEXT,
ADD COLUMN "notionPrdSyncError" TEXT,
ADD COLUMN "notionPrdSyncStatus" TEXT DEFAULT 'PENDING',
ADD COLUMN "notionPrdSyncedAt" TIMESTAMP(3),
ADD COLUMN "notionPrdWorkflowId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "project_notionPrdContextId_key" ON "project"("notionPrdContextId");

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_notionPrdContextId_fkey" FOREIGN KEY ("notionPrdContextId") REFERENCES "project_context"("id") ON DELETE SET NULL ON UPDATE CASCADE;
