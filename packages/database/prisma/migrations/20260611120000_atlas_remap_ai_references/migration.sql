-- AlterTable: distinguish AI-generated solo references (regeneratable by re-map)
-- from hand-authored user edge edits.
ALTER TABLE "code_understanding_edge_override"
    ADD COLUMN "isAiGenerated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: project-level "System map" relationship recompute history.
CREATE TABLE "code_understanding_cross_link_run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "triggeredByUserId" TEXT,
    "trigger" TEXT NOT NULL,
    "status" "CodeUnderstandingRunStatus" NOT NULL DEFAULT 'RUNNING',
    "repositoryIntegrationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "totalTokens" INTEGER,
    "costMicroUsd" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_understanding_cross_link_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_understanding_cross_link_run_projectId_startedAt_idx" ON "code_understanding_cross_link_run"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "code_understanding_cross_link_run_userId_idx" ON "code_understanding_cross_link_run"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_cross_link_run_organizationId_idx" ON "code_understanding_cross_link_run"("organizationId");

-- AddForeignKey
ALTER TABLE "code_understanding_cross_link_run" ADD CONSTRAINT "code_understanding_cross_link_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
