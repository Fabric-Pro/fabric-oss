-- AlterTable
ALTER TABLE "project_rag_settings" ADD COLUMN     "codeSearchEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "codeSearchProvider" TEXT;
