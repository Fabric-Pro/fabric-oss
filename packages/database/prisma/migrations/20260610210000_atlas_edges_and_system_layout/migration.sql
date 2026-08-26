-- CreateTable
CREATE TABLE "code_understanding_system_layout" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" "CodeUnderstandingGraphMode" NOT NULL,
    "nodeId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_understanding_system_layout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_understanding_edge_override" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "mode" "CodeUnderstandingGraphMode" NOT NULL,
    "sourceRepositoryIntegrationId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "targetRepositoryIntegrationId" TEXT,
    "targetKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userDescription" TEXT,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "isCrossRepo" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "updatedByUserId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_understanding_edge_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_understanding_edge_override_history" (
    "id" TEXT NOT NULL,
    "overrideId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "editedByUserId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_understanding_edge_override_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_understanding_system_layout_projectId_mode_idx" ON "code_understanding_system_layout"("projectId", "mode");

-- CreateIndex
CREATE INDEX "code_understanding_system_layout_userId_idx" ON "code_understanding_system_layout"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_system_layout_organizationId_idx" ON "code_understanding_system_layout"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "code_understanding_system_layout_projectId_mode_nodeId_key" ON "code_understanding_system_layout"("projectId", "mode", "nodeId");

-- CreateIndex
CREATE INDEX "code_understanding_edge_override_projectId_mode_idx" ON "code_understanding_edge_override"("projectId", "mode");

-- CreateIndex
CREATE INDEX "code_understanding_edge_override_userId_idx" ON "code_understanding_edge_override"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_edge_override_organizationId_idx" ON "code_understanding_edge_override"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "code_understanding_edge_override_projectId_branch_mode_sour_key" ON "code_understanding_edge_override"("projectId", "branch", "mode", "sourceRepositoryIntegrationId", "sourceKey", "targetRepositoryIntegrationId", "targetKey");

-- CreateIndex
CREATE INDEX "code_understanding_edge_override_history_overrideId_created_idx" ON "code_understanding_edge_override_history"("overrideId", "createdAt");

-- CreateIndex
CREATE INDEX "code_understanding_edge_override_history_userId_idx" ON "code_understanding_edge_override_history"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_edge_override_history_organizationId_idx" ON "code_understanding_edge_override_history"("organizationId");

-- AddForeignKey
ALTER TABLE "code_understanding_system_layout" ADD CONSTRAINT "code_understanding_system_layout_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_understanding_edge_override" ADD CONSTRAINT "code_understanding_edge_override_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_understanding_edge_override_history" ADD CONSTRAINT "code_understanding_edge_override_history_overrideId_fkey" FOREIGN KEY ("overrideId") REFERENCES "code_understanding_edge_override"("id") ON DELETE CASCADE ON UPDATE CASCADE;

