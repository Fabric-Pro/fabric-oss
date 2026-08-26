-- URL Context Sources — schema + per-page child table.
-- See fabric/specs/2026-05-13-url-context-sources/spec.md §5.1, §5.2.
-- Migration is additive; all new columns nullable so existing LINK rows are
-- unaffected. Backfill at the bottom sets sensible defaults for existing
-- LINK contexts so the new code paths can treat them as SINGLE_PAGE / ONCE.

-- CreateEnum
CREATE TYPE "UrlSourceScope" AS ENUM ('SINGLE_PAGE', 'PATH_PREFIX');

-- CreateEnum
CREATE TYPE "UrlRefreshMode" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'LIVE');

-- AlterTable: additive columns for URL Context Sources on ProjectContext.
ALTER TABLE "project_context"
    ADD COLUMN "urlScope" "UrlSourceScope",
    ADD COLUMN "urlMaxPages" INTEGER,
    ADD COLUMN "urlRefreshMode" "UrlRefreshMode",
    ADD COLUMN "urlNextRefreshAt" TIMESTAMP(3),
    ADD COLUMN "urlLastSyncedAt" TIMESTAMP(3),
    ADD COLUMN "urlScheduleId" TEXT;

-- CreateTable: per-page row for PATH_PREFIX crawls. Single-page sources do
-- NOT create rows here (the parent row's `content` holds the page markdown).
CREATE TABLE "project_context_url_page" (
    "id" TEXT NOT NULL,
    "parentContextId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "pageTitle" TEXT,
    "content" TEXT NOT NULL,
    "qdrantId" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "lastFetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "etag" TEXT,
    "lastModifiedHeader" TEXT,
    "contentHash" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extractionError" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_url_page_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_context_url_page_parentContextId_idx" ON "project_context_url_page"("parentContextId");

-- CreateIndex
CREATE INDEX "project_context_url_page_projectId_idx" ON "project_context_url_page"("projectId");

-- CreateIndex
CREATE INDEX "project_context_url_page_qdrantId_idx" ON "project_context_url_page"("qdrantId");

-- CreateIndex
CREATE INDEX "project_context_url_page_extractionStatus_idx" ON "project_context_url_page"("extractionStatus");

-- CreateIndex
CREATE INDEX "project_context_url_page_userId_idx" ON "project_context_url_page"("userId");

-- CreateIndex
CREATE INDEX "project_context_url_page_organizationId_idx" ON "project_context_url_page"("organizationId");

-- CreateIndex
CREATE INDEX "project_context_url_page_parentContextId_extractionStatus_idx" ON "project_context_url_page"("parentContextId", "extractionStatus");

-- AddForeignKey
ALTER TABLE "project_context_url_page" ADD CONSTRAINT "project_context_url_page_parentContextId_fkey" FOREIGN KEY ("parentContextId") REFERENCES "project_context"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_url_page" ADD CONSTRAINT "project_context_url_page_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_url_page" ADD CONSTRAINT "project_context_url_page_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing LINK rows so the new code paths can read sane defaults.
-- Per spec.md §5.1: urlScope = SINGLE_PAGE, urlRefreshMode = ONCE,
-- urlMaxPages stays NULL (no scheduled re-crawl for legacy rows).
UPDATE "project_context"
SET "urlScope" = 'SINGLE_PAGE'::"UrlSourceScope",
    "urlRefreshMode" = 'ONCE'::"UrlRefreshMode"
WHERE "type" = 'LINK'
  AND "urlScope" IS NULL;
