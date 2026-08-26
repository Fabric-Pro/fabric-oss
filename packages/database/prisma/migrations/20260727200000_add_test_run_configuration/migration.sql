-- Saved, reusable run configurations for Fabric-orchestrated runs (mocks C8).
--
-- The QA policy already carries the project's DEFAULTS. This is a named
-- override of them, so a team running the same shaped run repeatedly does not
-- re-pick it each time.
--
-- Deliberately does NOT store a case list: a configuration says HOW a run
-- executes, never WHICH cases. A saved selection would go stale the moment
-- somebody added a case, and would quietly stop covering new work while still
-- looking like a regression suite.
--
-- `environmentId` is intentionally NOT a foreign key, matching
-- `project_qa_settings.defaultEnvironmentId`: a deleted environment must
-- degrade to "use the project default", not cascade-delete the configuration.
CREATE TABLE "test_run_configuration" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "environmentId" TEXT,
    "browser" TEXT,
    "resolution" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_run_configuration_pkey" PRIMARY KEY ("id")
);

-- One name per project: a picker with two "Nightly regression" entries is a
-- picker nobody can use.
CREATE UNIQUE INDEX "test_run_configuration_projectId_name_key"
    ON "test_run_configuration"("projectId", "name");
CREATE INDEX "test_run_configuration_projectId_idx"
    ON "test_run_configuration"("projectId");

ALTER TABLE "test_run_configuration" ADD CONSTRAINT "test_run_configuration_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_run_configuration" ADD CONSTRAINT "test_run_configuration_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_run_configuration" ADD CONSTRAINT "test_run_configuration_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
