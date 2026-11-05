
-- References carry no source content and cannot cross organization boundaries,
-- including writes made by an owner/bypass role. API source permissions remain separate.
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
ALTER TABLE "project_workspace_document_link" ENABLE ROW LEVEL SECURITY;

							CREATE POLICY tenant_isolation ON "project_workspace_document_link"
							USING (
								(
									EXISTS (
										SELECT 1
										FROM "project" AS p
										WHERE p."id" = "project_workspace_document_link"."projectId"
										AND CASE current_tenant_type()
										WHEN 'organization' THEN
											p."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											p."userId" = current_user_id() AND p."organizationId" IS NULL
										ELSE false
									END
									)
									OR EXISTS (
										SELECT 1
										FROM "project_member" AS m
										WHERE m."projectId" = "project_workspace_document_link"."projectId"
										AND m."userId" = current_user_id()
										AND m."acceptedAt" IS NOT NULL
										AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
									)
								)
							)
							WITH CHECK (
								(
									EXISTS (
										SELECT 1
										FROM "project" AS p
										WHERE p."id" = "project_workspace_document_link"."projectId"
										AND CASE current_tenant_type()
										WHEN 'organization' THEN
											p."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											p."userId" = current_user_id() AND p."organizationId" IS NULL
										ELSE false
									END
									)
									OR EXISTS (
										SELECT 1
										FROM "project_member" AS m
										WHERE m."projectId" = "project_workspace_document_link"."projectId"
										AND m."userId" = current_user_id()
										AND m."acceptedAt" IS NOT NULL
										AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
									)
								)
								AND EXISTS (
									SELECT 1
									FROM "project" AS op
									WHERE op."id" = "project_workspace_document_link"."projectId"
									AND op."organizationId" = "project_workspace_document_link"."organizationId"
								)
							)
						
