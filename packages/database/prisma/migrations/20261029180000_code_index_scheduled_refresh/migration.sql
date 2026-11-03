-- migration-lint: allow blocking-index — project_code_index holds one row per indexed repository, so the build is brief
-- CreateEnum
CREATE TYPE "CodeIndexRefreshInterval" AS ENUM ('OFF', 'HOURLY', 'EVERY_6_HOURS', 'DAILY');

-- AlterTable
ALTER TABLE "project_rag_settings" ADD COLUMN     "codeIndexRefreshInterval" "CodeIndexRefreshInterval" NOT NULL DEFAULT 'DAILY';

-- AlterTable
ALTER TABLE "project_code_index" ADD COLUMN     "lastRefreshCheckAt" TIMESTAMP(3),
ADD COLUMN     "lastRefreshError" TEXT,
ADD COLUMN     "nextRefreshCheckAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "project_code_index_nextRefreshCheckAt_idx" ON "project_code_index"("nextRefreshCheckAt");

