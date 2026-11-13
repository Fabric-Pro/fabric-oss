-- Coding Instructions sets (spec 2026-11-11): the (id, projectId) key a set's
-- repository assignment references, so a set can only take a repository of its
-- own project. Built CONCURRENTLY, alone in its migration.

CREATE UNIQUE INDEX CONCURRENTLY "project_repository_integration_id_projectId_key" ON "project_repository_integration"("id", "projectId");
