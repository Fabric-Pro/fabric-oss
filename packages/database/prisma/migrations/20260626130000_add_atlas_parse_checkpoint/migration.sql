-- Resumability for the Atlas structure (clone+parse) phase: one row per parsed
-- file holding only the compact content-free FileMeta. A retried activity reloads
-- these and skips re-parsing those files; the holistic assembly still re-runs over
-- the complete set, so the graph stays byte-identical. Additive; no existing data
-- is touched.

-- CreateTable
CREATE TABLE "atlas_parse_checkpoint" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "namespace" TEXT,
    "loc" INTEGER NOT NULL,
    "symbolCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contentPreview" TEXT NOT NULL,
    "importSpecs" TEXT[],
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "atlas_parse_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "atlas_parse_checkpoint_analysisId_path_key" ON "atlas_parse_checkpoint"("analysisId", "path");

-- CreateIndex
CREATE INDEX "atlas_parse_checkpoint_analysisId_commitSha_idx" ON "atlas_parse_checkpoint"("analysisId", "commitSha");

-- CreateIndex
CREATE INDEX "atlas_parse_checkpoint_organizationId_idx" ON "atlas_parse_checkpoint"("organizationId");

-- AddForeignKey
ALTER TABLE "atlas_parse_checkpoint" ADD CONSTRAINT "atlas_parse_checkpoint_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "atlas_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
