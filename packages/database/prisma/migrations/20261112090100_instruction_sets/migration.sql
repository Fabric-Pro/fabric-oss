-- Coding Instructions sets (spec 2026-11-11, "a set is a folder"): a project's
-- named sets and the code repositories each applies to. Two new tables only;
-- no existing table changes. A set's files are the folder instructions/<slug>/
-- of the project's one instructions source. The data backfill (a default set
-- per project, holding its code repositories) is
-- scripts/backfill-instruction-sets.ts, out of band.

CREATE TABLE "project_instruction_set" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_instruction_set_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_instruction_set_repository" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "repositoryIntegrationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_instruction_set_repository_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_instruction_set_organizationId_idx" ON "project_instruction_set"("organizationId");

CREATE INDEX "project_instruction_set_userId_idx" ON "project_instruction_set"("userId");

CREATE UNIQUE INDEX "project_instruction_set_id_projectId_key" ON "project_instruction_set"("id", "projectId");

CREATE INDEX "project_instruction_set_projectId_idx" ON "project_instruction_set"("projectId");

CREATE INDEX "project_instruction_set_repository_repositoryIntegrationId_idx" ON "project_instruction_set_repository"("repositoryIntegrationId");

CREATE INDEX "project_instruction_set_repository_projectId_idx" ON "project_instruction_set_repository"("projectId");

CREATE INDEX "project_instruction_set_repository_organizationId_idx" ON "project_instruction_set_repository"("organizationId");

CREATE INDEX "project_instruction_set_repository_userId_idx" ON "project_instruction_set_repository"("userId");

CREATE UNIQUE INDEX "project_instruction_set_repository_setId_repositoryIntegrat_key" ON "project_instruction_set_repository"("setId", "repositoryIntegrationId");

ALTER TABLE "project_instruction_set" ADD CONSTRAINT "project_instruction_set_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_instruction_set" ADD CONSTRAINT "project_instruction_set_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_instruction_set_repository" ADD CONSTRAINT "project_instruction_set_repository_set_fkey" FOREIGN KEY ("setId", "projectId") REFERENCES "project_instruction_set"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_instruction_set_repository" ADD CONSTRAINT "project_instruction_set_repository_integration_fkey" FOREIGN KEY ("repositoryIntegrationId", "projectId") REFERENCES "project_repository_integration"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_instruction_set_repository" ADD CONSTRAINT "project_instruction_set_repository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_instruction_set_repository" ADD CONSTRAINT "project_instruction_set_repository_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one default set per project. Prisma cannot express a partial unique
-- index; it is documented on the ProjectInstructionSet model.
CREATE UNIQUE INDEX "project_instruction_set_one_default_key" ON "project_instruction_set"("projectId") WHERE "isDefault";

-- A slug is unique among a project's live sets; a deleted set (soft, D7: its
-- files stay in git) frees its slug. Also documented on the model.
CREATE UNIQUE INDEX "project_instruction_set_live_slug_key" ON "project_instruction_set"("projectId", "slug") WHERE "deletedAt" IS NULL;
