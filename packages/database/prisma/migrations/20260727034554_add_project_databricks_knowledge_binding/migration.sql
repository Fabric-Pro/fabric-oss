-- CreateTable
CREATE TABLE "project_databricks_knowledge_binding" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "allowedResources" JSONB NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "project_databricks_knowledge_binding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_databricks_knowledge_binding_projectId_key" ON "project_databricks_knowledge_binding"("projectId");

-- CreateIndex
CREATE INDEX "project_databricks_knowledge_binding_integrationId_idx" ON "project_databricks_knowledge_binding"("integrationId");

-- AddForeignKey
ALTER TABLE "project_databricks_knowledge_binding" ADD CONSTRAINT "project_databricks_knowledge_binding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_databricks_knowledge_binding" ADD CONSTRAINT "project_databricks_knowledge_binding_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "workflow_integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- NOTE (Small, Focused Changes — fabric/standards/backend/migrations.md):
-- `prisma migrate dev` also proposed an `mcp_server_default_enabled_idx`
-- CREATE INDEX and a `coding_run_status_startedAt_idx` rename here. Both are
-- pre-existing history/schema drift unrelated to this feature (and the
-- mcp_server statement would be a permanent no-op: that index name already
-- exists from 20260511072912 as a PARTIAL index, so IF NOT EXISTS skips it
-- forever without resolving the drift). Stripped, matching the convention of
-- 20260523172126 / 20260618120000 / 20260701114605. Resolving the underlying
-- drift is a separate, dedicated change.
