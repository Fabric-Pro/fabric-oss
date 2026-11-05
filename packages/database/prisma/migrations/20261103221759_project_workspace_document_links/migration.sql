-- CreateTable
CREATE TABLE "project_workspace_document_link" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "addedByUserId" TEXT NOT NULL,
    "sourceRevisionAtLink" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_workspace_document_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_workspace_document_link_organizationId_projectId_idx" ON "project_workspace_document_link"("organizationId", "projectId");

-- CreateIndex
CREATE INDEX "project_workspace_document_link_documentId_idx" ON "project_workspace_document_link"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "project_workspace_doc_link_project_document_key" ON "project_workspace_document_link"("projectId", "documentId");

-- AddForeignKey
ALTER TABLE "project_workspace_document_link" ADD CONSTRAINT "project_workspace_document_link_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_workspace_document_link" ADD CONSTRAINT "project_workspace_document_link_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "workspace_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
