-- Run outside a transaction: organizations remain writable during the index
-- build. Unique: a project is the template of at most one organization.
CREATE UNIQUE INDEX CONCURRENTLY "organization_instructionTemplateProjectId_key" ON "organization"("instructionTemplateProjectId");
