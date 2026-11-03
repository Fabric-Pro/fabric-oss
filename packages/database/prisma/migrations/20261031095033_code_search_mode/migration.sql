-- CreateEnum
CREATE TYPE "CodeSearchMode" AS ENUM ('OFF', 'CODE_SEARCH', 'RAG');

-- AlterTable
ALTER TABLE "project_rag_settings" ADD COLUMN     "codeSearchMode" "CodeSearchMode" NOT NULL DEFAULT 'OFF';

-- AlterTable
ALTER TABLE "project_repository_integration" ADD COLUMN     "includedInCodeSearch" BOOLEAN NOT NULL DEFAULT true;

-- Carry each project's existing choice over (spec 2026-10-29 code-index-sync
-- §6a). Data only: nothing is re-indexed. A project with code search on and a
-- ready code index keeps answering from that index (RAG); with code search on
-- and no ready index it keeps reading the provider live (CODE_SEARCH); off
-- stays OFF. Every repository starts included, as every one was searched
-- before.
UPDATE "project_rag_settings" AS s
SET "codeSearchMode" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "project_code_index" AS i
    WHERE i."projectId" = s."projectId" AND i."status" = 'READY'
  ) THEN 'RAG'::"CodeSearchMode"
  ELSE 'CODE_SEARCH'::"CodeSearchMode"
END
WHERE s."codeSearchEnabled" = true;
