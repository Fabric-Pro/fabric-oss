-- CreateTable
CREATE TABLE "diagram" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "elements" JSONB NOT NULL,
    "appState" JSONB,
    "checkpointId" TEXT,
    "mcpConfigId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diagram_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "diagram_userId_idx" ON "diagram"("userId");

-- CreateIndex
CREATE INDEX "diagram_organizationId_idx" ON "diagram"("organizationId");

-- CreateIndex
CREATE INDEX "diagram_projectId_idx" ON "diagram"("projectId");

-- CreateIndex
CREATE INDEX "diagram_checkpointId_idx" ON "diagram"("checkpointId");

-- AddForeignKey
ALTER TABLE "diagram" ADD CONSTRAINT "diagram_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagram" ADD CONSTRAINT "diagram_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagram" ADD CONSTRAINT "diagram_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
