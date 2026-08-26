-- Drop old Notion-specific FK/index before renaming the bound context column.
ALTER TABLE "project" DROP CONSTRAINT "project_notionPrdContextId_fkey";
DROP INDEX "project_notionPrdContextId_key";

-- Rename the surviving PRD source columns to generic names.
ALTER TABLE "project"
  RENAME COLUMN "notionPrdContextId" TO "prdSourceContextId";

ALTER TABLE "project"
  RENAME COLUMN "notionPrdSyncedAt" TO "prdSourceSyncedAt";

-- Drop the last dead transitional columns.
ALTER TABLE "project"
  DROP COLUMN "notionPrdSyncStatus",
  DROP COLUMN "googleDriveAutoSyncEnabled",
  DROP COLUMN "googleDriveAutoSyncIntervalMin",
  DROP COLUMN "googleDriveAutoSyncLastRun",
  DROP COLUMN "googleDriveAutoSyncWorkflowId";

-- Recreate the generic FK/index with stable names.
CREATE UNIQUE INDEX "project_prdSourceContextId_key" ON "project"("prdSourceContextId");

ALTER TABLE "project"
  ADD CONSTRAINT "project_prdSourceContextId_fkey"
  FOREIGN KEY ("prdSourceContextId")
  REFERENCES "project_context"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
