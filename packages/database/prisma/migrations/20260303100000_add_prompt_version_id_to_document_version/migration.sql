-- AlterTable
ALTER TABLE "document_version" ADD COLUMN "promptVersionId" TEXT;

-- CreateIndex
CREATE INDEX "document_version_promptVersionId_idx" ON "document_version"("promptVersionId");

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "prompt_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;
