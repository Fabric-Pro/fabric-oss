-- Generated visuals' identity and specs in a Proposal's Main (Fizzy #2946).
--
-- A visual the generation's visuals step (or Edit with instructions) writes
-- into Main opens its fence with `%% fabric-visual: <id>`; this table keeps
-- the fact-checked spec behind each one, keyed by document, visual id and the
-- fence body's normalised hash. Append-only: a restored version's fence finds
-- the row it was generated with, and a fence whose body no row matches reads
-- as edited by a person. The style row gains the switch that turns the
-- generation's diagrams off for one document.
--
-- No backfill: no fence carried a marker before this change, and the new
-- column's default keeps every existing document's current behaviour.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "project_document_style" ADD COLUMN     "autoVisuals" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "project_document_visual_spec" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "visualId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "specHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_document_visual_spec_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_document_visual_spec_projectId_idx" ON "project_document_visual_spec"("projectId");

-- CreateIndex
CREATE INDEX "project_document_visual_spec_organizationId_idx" ON "project_document_visual_spec"("organizationId");

-- CreateIndex
CREATE INDEX "project_document_visual_spec_createdById_idx" ON "project_document_visual_spec"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "project_document_visual_spec_documentId_visualId_sourceHash_key" ON "project_document_visual_spec"("documentId", "visualId", "sourceHash");

-- AddForeignKey
ALTER TABLE "project_document_visual_spec" ADD CONSTRAINT "project_document_visual_spec_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_visual_spec" ADD CONSTRAINT "project_document_visual_spec_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_visual_spec" ADD CONSTRAINT "project_document_visual_spec_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_visual_spec" ADD CONSTRAINT "project_document_visual_spec_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The table is new and empty, so each check is satisfied without a scan. The
-- id and hashes are the shapes the server writes (the hashes are versioned,
-- so a later normaliser writes a new prefix); origin names who generated the
-- visual.
ALTER TABLE "project_document_visual_spec" ADD CONSTRAINT "project_document_visual_spec_fields_check"
  CHECK ("visualId" ~ '^[a-z0-9]{12,32}$'
         AND "sourceHash" ~ '^v[0-9]+:[0-9a-f]{16}$'
         AND "specHash" ~ '^v[0-9]+:[0-9a-f]{16}$'
         AND "kind" ~ '^[a-z_]{1,32}$'
         AND "origin" IN ('STEP', 'INSTRUCTION'));
