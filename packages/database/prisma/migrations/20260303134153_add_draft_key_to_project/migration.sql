-- AlterTable: add draftKey for draft project identification
ALTER TABLE "project" ADD COLUMN "draftKey" TEXT;

-- CreateIndex
CREATE INDEX "project_userId_draftKey_idx" ON "project"("userId", "draftKey");
