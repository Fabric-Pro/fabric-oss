-- CreateEnum
CREATE TYPE "DocumentSource" AS ENUM ('GENERATED', 'IMPORTED', 'EXTERNAL');

-- AlterTable
ALTER TABLE "project_document" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "source" "DocumentSource" NOT NULL DEFAULT 'GENERATED',
ADD COLUMN     "sourceContextId" TEXT;

-- CreateIndex
CREATE INDEX "project_document_sourceContextId_idx" ON "project_document"("sourceContextId");

-- CreateIndex
CREATE INDEX "project_document_isActive_idx" ON "project_document"("isActive");

-- AddForeignKey
ALTER TABLE "project_document" ADD CONSTRAINT "project_document_sourceContextId_fkey" FOREIGN KEY ("sourceContextId") REFERENCES "project_context"("id") ON DELETE SET NULL ON UPDATE CASCADE;
