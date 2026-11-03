-- migration-lint: allow blocking-index — knowledge_entry was created by the previous migration and is empty in every environment
-- AlterTable
ALTER TABLE "knowledge_entry" ADD COLUMN     "sourcePath" TEXT;

-- CreateIndex
CREATE INDEX "knowledge_entry_topicId_sourcePath_idx" ON "knowledge_entry"("topicId", "sourcePath");
