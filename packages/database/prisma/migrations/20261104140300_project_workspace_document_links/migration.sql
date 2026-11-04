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

-- References carry no source content and cannot cross organization boundaries,
-- including writes made by an owner/bypass role. API source permissions remain separate.
-- RLS policies on project_workspace_document_link are managed by apply-rls-direct.ts (deploy:rls).
ALTER TABLE "project_workspace_document_link" ADD CONSTRAINT "project_workspace_document_revision_check" CHECK ("sourceRevisionAtLink" ~ '^[a-f0-9]{64}$');
CREATE FUNCTION enforce_project_workspace_document_link_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM project p
  JOIN workspace_document d ON d.id = NEW."documentId"
  JOIN workspace w ON w.id = d."workspaceId"
  WHERE p.id = NEW."projectId" AND p."organizationId" = NEW."organizationId"
   AND w."organizationId" = NEW."organizationId"
 ) THEN
  RAISE EXCEPTION 'Project and document reference must belong to the same organization' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER project_workspace_document_link_tenant_guard BEFORE INSERT OR UPDATE ON "project_workspace_document_link"
 FOR EACH ROW EXECUTE FUNCTION enforce_project_workspace_document_link_tenant();
