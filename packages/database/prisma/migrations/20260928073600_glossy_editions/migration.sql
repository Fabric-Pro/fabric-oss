-- Glossy editions (Fizzy #2589): five project tables beside the document, and
-- the organization's Brand kit.
--
-- Schema delta: six NEW tables, their indexes, their foreign keys, and the
-- CHECK constraints below. Nothing existing is altered — no existing table,
-- column, index or enum (BackgroundJob and its enums included).
-- __tests__/glossy-migration-scope.test.ts holds this file to that.
--
--   * glossy_edition — one per document: published content, the attempt that
--     holds the build claim (`currentBuildId`), the attempt it was published
--     from (`publishedBuildId`), and a `contentRevision` guard.
--   * glossy_build — one row per build attempt: source snapshot, options,
--     status, heartbeat, progress, report, and a fixed error code.
--   * glossy_visual_decision — review decisions by visual key.
--   * glossy_segment_cache — reusable model outputs, pruned by age at finalize.
--   * project_recipient_brand — one per project, with a compare-and-set
--     `version`.
--   * organization_brand_kit — one per organization: accents and guidance.
--     Its own table rather than organization metadata, which the auth library
--     writes wholesale.
--
-- Tenancy: every project table carries a non-null organizationId and projectId
-- and no userId (ADR-018). RLS (scripts/apply-rls-direct.ts) gives the five
-- project tables `project_member_or_tenant_consistent` and the Brand kit
-- `org_only_with_project_guest_read`.
--
-- Status, kind and decision columns are TEXT with the CHECK constraints below,
-- following document_auto_refresh_settings.cadence, so a new value costs no
-- enum migration. The CHECKs make an invalid row unrepresentable rather than
-- merely rejected by zod, which a seed, a restore or psql does not pass
-- through. Prisma does not model CHECK constraints, so they are hand-added
-- here and are invisible to later schema diffs.
--
-- Generated with `prisma migrate dev --create-only`. The generator also
-- emitted 31 statements against existing tables — dropped foreign keys and
-- indexes, dropped defaults, index renames — that reproduce identically when
-- diffing the unmodified schema, i.e. pre-existing drift between
-- schema.prisma and hand-authored migrations. They are not part of this
-- change and were removed.
--
-- No backfill, no lock on an existing table: every statement targets a table
-- created here, so each index and constraint builds over zero rows.
-- Rollback: the tables are additive and unread with the GLOSSY_EDITION gate
-- off; a later contract migration can drop them.

-- CreateTable
CREATE TABLE "glossy_edition" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "content" JSONB,
    "publishedBuildId" TEXT,
    "contentRevision" INTEGER NOT NULL DEFAULT 0,
    "currentBuildId" TEXT,
    "lastOptions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "glossy_edition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "glossy_build" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "workflowId" TEXT,
    "options" JSONB NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "sourceContent" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "sourceContentHash" TEXT NOT NULL,
    "progressStep" TEXT,
    "sectionsDone" INTEGER NOT NULL DEFAULT 0,
    "sectionsTotal" INTEGER,
    "report" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "glossy_build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "glossy_visual_decision" (
    "id" TEXT NOT NULL,
    "editionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "visualKey" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "specHash" TEXT,
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "glossy_visual_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "glossy_segment_cache" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "sectionKey" TEXT,
    "output" JSONB NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "glossy_segment_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_recipient_brand" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT,
    "website" TEXT,
    "logoKey" TEXT,
    "colors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_recipient_brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_brand_kit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accentColors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "guidance" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_brand_kit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "glossy_edition_documentId_key" ON "glossy_edition"("documentId");

-- CreateIndex
CREATE INDEX "glossy_edition_projectId_idx" ON "glossy_edition"("projectId");

-- CreateIndex
CREATE INDEX "glossy_edition_organizationId_idx" ON "glossy_edition"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "glossy_edition_id_projectId_key" ON "glossy_edition"("id", "projectId");

-- CreateIndex
CREATE INDEX "glossy_build_documentId_startedAt_idx" ON "glossy_build"("documentId", "startedAt");

-- CreateIndex
CREATE INDEX "glossy_build_projectId_idx" ON "glossy_build"("projectId");

-- CreateIndex
CREATE INDEX "glossy_build_organizationId_idx" ON "glossy_build"("organizationId");

-- CreateIndex
CREATE INDEX "glossy_build_startedById_idx" ON "glossy_build"("startedById");

-- CreateIndex
CREATE INDEX "glossy_visual_decision_projectId_idx" ON "glossy_visual_decision"("projectId");

-- CreateIndex
CREATE INDEX "glossy_visual_decision_organizationId_idx" ON "glossy_visual_decision"("organizationId");

-- CreateIndex
CREATE INDEX "glossy_visual_decision_decidedById_idx" ON "glossy_visual_decision"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "glossy_visual_decision_editionId_visualKey_key" ON "glossy_visual_decision"("editionId", "visualKey");

-- CreateIndex
CREATE INDEX "glossy_segment_cache_projectId_idx" ON "glossy_segment_cache"("projectId");

-- CreateIndex
CREATE INDEX "glossy_segment_cache_organizationId_idx" ON "glossy_segment_cache"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "glossy_segment_cache_documentId_kind_cacheKey_key" ON "glossy_segment_cache"("documentId", "kind", "cacheKey");

-- CreateIndex
CREATE UNIQUE INDEX "project_recipient_brand_projectId_key" ON "project_recipient_brand"("projectId");

-- CreateIndex
CREATE INDEX "project_recipient_brand_organizationId_idx" ON "project_recipient_brand"("organizationId");

-- CreateIndex
CREATE INDEX "project_recipient_brand_updatedById_idx" ON "project_recipient_brand"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "organization_brand_kit_organizationId_key" ON "organization_brand_kit"("organizationId");

-- CreateIndex
CREATE INDEX "organization_brand_kit_updatedById_idx" ON "organization_brand_kit"("updatedById");

-- AddForeignKey
ALTER TABLE "glossy_edition" ADD CONSTRAINT "glossy_edition_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_edition" ADD CONSTRAINT "glossy_edition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_edition" ADD CONSTRAINT "glossy_edition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_build" ADD CONSTRAINT "glossy_build_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_build" ADD CONSTRAINT "glossy_build_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_build" ADD CONSTRAINT "glossy_build_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_build" ADD CONSTRAINT "glossy_build_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_visual_decision" ADD CONSTRAINT "glossy_visual_decision_editionId_projectId_fkey" FOREIGN KEY ("editionId", "projectId") REFERENCES "glossy_edition"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_visual_decision" ADD CONSTRAINT "glossy_visual_decision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_visual_decision" ADD CONSTRAINT "glossy_visual_decision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_visual_decision" ADD CONSTRAINT "glossy_visual_decision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_segment_cache" ADD CONSTRAINT "glossy_segment_cache_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_segment_cache" ADD CONSTRAINT "glossy_segment_cache_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossy_segment_cache" ADD CONSTRAINT "glossy_segment_cache_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_recipient_brand" ADD CONSTRAINT "project_recipient_brand_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_recipient_brand" ADD CONSTRAINT "project_recipient_brand_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_recipient_brand" ADD CONSTRAINT "project_recipient_brand_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-added CHECK constraints. Each targets a table created above, so it
-- validates zero rows.
-- ---------------------------------------------------------------------------

-- A build attempt is in exactly one of four states. BUILDING holds the claim;
-- the other three are terminal for that attempt (a rebuild is a new attempt).
ALTER TABLE "glossy_build" ADD CONSTRAINT "glossy_build_status_check"
  CHECK ("status" IN ('BUILDING', 'SUCCEEDED', 'FAILED', 'SUPERSEDED'));

-- A building attempt has a heartbeat and a start time: a stale-holder reclaim
-- decides on the heartbeat, so a BUILDING row without one could never be
-- reclaimed.
ALTER TABLE "glossy_build" ADD CONSTRAINT "glossy_build_building_liveness_check"
  CHECK ("status" <> 'BUILDING'
         OR ("heartbeatAt" IS NOT NULL AND "startedAt" IS NOT NULL));

ALTER TABLE "glossy_build" ADD CONSTRAINT "glossy_build_progress_check"
  CHECK ("sectionsDone" >= 0
         AND ("sectionsTotal" IS NULL OR "sectionsTotal" >= 0));

-- Published content and the attempt it came from are both present or both
-- absent: finalize swaps them in one statement, and a failed rebuild touches
-- neither.
ALTER TABLE "glossy_edition" ADD CONSTRAINT "glossy_edition_published_pair_check"
  CHECK (("content" IS NULL) = ("publishedBuildId" IS NULL));

ALTER TABLE "glossy_edition" ADD CONSTRAINT "glossy_edition_content_revision_check"
  CHECK ("contentRevision" >= 0);

ALTER TABLE "glossy_visual_decision" ADD CONSTRAINT "glossy_visual_decision_decision_check"
  CHECK ("decision" IN ('ACCEPTED', 'DISCARDED'));

-- An acceptance approves a specific spec; without its hash it would silently
-- approve every later regeneration of the same visual.
ALTER TABLE "glossy_visual_decision" ADD CONSTRAINT "glossy_visual_decision_accepted_hash_check"
  CHECK ("decision" <> 'ACCEPTED' OR "specHash" IS NOT NULL);

ALTER TABLE "glossy_segment_cache" ADD CONSTRAINT "glossy_segment_cache_kind_check"
  CHECK ("kind" IN ('REWRITE', 'DETECTION', 'EXTRACTION'));

ALTER TABLE "project_recipient_brand" ADD CONSTRAINT "project_recipient_brand_version_check"
  CHECK ("version" >= 1);

-- The logo is a server-issued object under THIS project's prefix. A key naming
-- another project's object, or any other path, cannot be stored.
ALTER TABLE "project_recipient_brand" ADD CONSTRAINT "project_recipient_brand_logo_key_check"
  CHECK ("logoKey" IS NULL
         OR "logoKey" ~ ('^project-brand/' || "projectId"
                         || '/recipient-brand/current/[A-Za-z0-9_-]+\.png$'));

-- Colors reach SVG fills and the PDF palette; only lowercase #rrggbb is
-- representable. array_to_string skips NULL elements, hence array_position.
ALTER TABLE "project_recipient_brand" ADD CONSTRAINT "project_recipient_brand_colors_check"
  CHECK (array_position("colors", NULL) IS NULL
         AND array_to_string("colors", ',') ~ '^(#[0-9a-f]{6}(,#[0-9a-f]{6})*)?$');

ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_accent_colors_check"
  CHECK (cardinality("accentColors") <= 3
         AND array_position("accentColors", NULL) IS NULL
         AND array_to_string("accentColors", ',') ~ '^(#[0-9a-f]{6}(,#[0-9a-f]{6})*)?$');

ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_guidance_check"
  CHECK ("guidance" IS NULL OR char_length("guidance") <= 2000);
