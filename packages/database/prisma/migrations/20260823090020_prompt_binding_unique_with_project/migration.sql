-- Replacement unique key including projectId. Single CONCURRENTLY statement:
-- Prisma does not wrap a one-statement migration in a transaction, and
-- CONCURRENTLY cannot run inside one.
CREATE UNIQUE INDEX CONCURRENTLY "prompt_binding_targetType_targetKey_documentType_storyKind__key" ON "prompt_binding"("targetType", "targetKey", "documentType", "storyKind", "scope", "userId", "organizationId", "projectId");
