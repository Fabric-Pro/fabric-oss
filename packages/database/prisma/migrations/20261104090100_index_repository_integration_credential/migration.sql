-- Keep the repository integration table writable while indexing the bound credential.
CREATE INDEX CONCURRENTLY "project_repository_integration_credentialId_idx" ON "project_repository_integration"("credentialId");
