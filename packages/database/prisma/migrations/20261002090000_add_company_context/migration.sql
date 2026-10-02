-- Company context (Fizzy #2719): the sources an organization maintains once
-- about itself, which Proposal and Business Case generation retrieve alongside
-- a project's own context.
--
-- Schema delta: two NEW tables, their indexes and their foreign keys. Nothing
-- existing is altered — in particular no DDL touches project_context or any of
-- its child tables. Company sources are a sibling store, not rows with a
-- nullable projectId there, so no project surface can read them.
--
--   * company_context_source — one row per source (FILE, TEXT, LINK; later
--     INTEGRATION). organizationId is NOT NULL and cascades with the
--     organization; createdByUserId is SetNull, so a departing admin never
--     deletes the organization's sources. embeddingModel records the model
--     identity the source was last embedded with; deletingAt tombstones a
--     source whose deletion has started.
--   * company_context_url_page — one row per crawled page of a PATH_PREFIX
--     LINK source, with its own embeddingModel.
--
-- Tenancy: organizationId is the only tenant column on both tables (ADR-018).
-- RLS (scripts/apply-rls-direct.ts) gives both `org_only`, with no
-- project-guest read branch.
--
-- company_context_url_page_owner_fkey is the constraint that keeps a page and
-- its parent in one organization. Postgres does not evaluate the parent's RLS
-- policy through a foreign key, so a key on parentSourceId alone would admit a
-- page naming another organization. The key is composite over
-- (parentSourceId, organizationId) against the unique
-- (id, organizationId) on the parent. Both columns are NOT NULL, so the
-- default MATCH SIMPLE always fires. ON UPDATE NO ACTION refuses a parent that
-- changes organization while it still has pages. schema.prisma declares it as
-- the @ignore'd `ownerParent` relation, so Prisma compares its full shape and
-- the drift check covers it; it needs no entry in
-- scripts/assert-handwritten-constraints.sql (no MATCH FULL, no SET NULL
-- column list).
--
-- Every index and key below lands on a table this migration CREATEs, so each
-- is built on an empty relation. The foreign keys to "organization" and "user"
-- take a SHARE ROW EXCLUSIVE lock on those tables only for the instant of the
-- ALTER; no validation scan runs because the new tables are empty.
--
-- Generated with `prisma migrate diff` from the previous datamodel to this
-- one, so it carries only this change's statements.

-- CreateTable
CREATE TABLE "company_context_source" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "ProjectContextType" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "qdrantId" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "embeddingModel" TEXT,
    "s3Path" TEXT,
    "s3Bucket" TEXT,
    "originalFilename" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extractionError" TEXT,
    "extractedAt" TIMESTAMP(3),
    "deletingAt" TIMESTAMP(3),
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "urlScope" "UrlSourceScope",
    "urlMaxPages" INTEGER,
    "urlRefreshMode" "UrlRefreshMode",
    "urlNextRefreshAt" TIMESTAMP(3),
    "urlLastSyncedAt" TIMESTAMP(3),
    "urlScheduleId" TEXT,
    "urlActiveWorkflowId" TEXT,
    "sourceType" TEXT,
    "aiInstructions" TEXT,
    "metadataUpdatedAt" TIMESTAMP(3),
    "metadataUpdatedByUserId" TEXT,
    "contentHash" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_context_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_context_url_page" (
    "id" TEXT NOT NULL,
    "parentSourceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "pageTitle" TEXT,
    "content" TEXT NOT NULL,
    "qdrantId" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "embeddingModel" TEXT,
    "lastFetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "etag" TEXT,
    "lastModifiedHeader" TEXT,
    "contentHash" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extractionError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_context_url_page_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The company context page's list: one organization's sources, newest first.
CREATE INDEX "company_context_source_organizationId_createdAt_idx" ON "company_context_source"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "company_context_source_createdByUserId_idx" ON "company_context_source"("createdByUserId");

-- CreateIndex
-- The target of company_context_url_page_owner_fkey. `id` alone already makes
-- the pair unique; a foreign key needs a unique index over exactly the columns
-- it references.
CREATE UNIQUE INDEX "company_context_source_id_organizationId_key" ON "company_context_source"("id", "organizationId");

-- CreateIndex
CREATE INDEX "company_context_url_page_parentSourceId_extractionStatus_idx" ON "company_context_url_page"("parentSourceId", "extractionStatus");

-- CreateIndex
CREATE INDEX "company_context_url_page_organizationId_idx" ON "company_context_url_page"("organizationId");

-- CreateIndex
-- One row per URL per source: a concurrent re-sync's insert of a page another
-- run already created conflicts instead of duplicating it.
CREATE UNIQUE INDEX "company_context_url_page_parentSourceId_pageUrl_key" ON "company_context_url_page"("parentSourceId", "pageUrl");

-- AddForeignKey
ALTER TABLE "company_context_source" ADD CONSTRAINT "company_context_source_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_context_source" ADD CONSTRAINT "company_context_source_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_context_url_page" ADD CONSTRAINT "company_context_url_page_parentSourceId_fkey" FOREIGN KEY ("parentSourceId") REFERENCES "company_context_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- The ownership constraint. Read the header.
ALTER TABLE "company_context_url_page" ADD CONSTRAINT "company_context_url_page_owner_fkey" FOREIGN KEY ("parentSourceId", "organizationId") REFERENCES "company_context_source"("id", "organizationId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_context_url_page" ADD CONSTRAINT "company_context_url_page_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
