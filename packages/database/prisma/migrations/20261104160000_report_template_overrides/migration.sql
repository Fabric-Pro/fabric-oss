-- Report suite: an organization's and a project's defaults for the reports
-- they create from a template.
--
-- One row per (template, organization) with projectId NULL holds the
-- organization's defaults; one row per (template, organization, project)
-- holds a project's. A new report takes project values over organization
-- values over the template's own.
--
-- The unique key is NULLS NOT DISTINCT (Postgres 15+), so an organization
-- holds exactly one org-wide row per template: a plain unique index treats
-- NULL projectIds as distinct and would accept duplicates. Prisma cannot
-- express the modifier; schema.prisma declares @@unique over the same columns
-- with the same name (see 20260903100000_prompt_binding_unique_nulls_not_distinct).
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change. The table is new and empty, so its indexes and
-- foreign keys are built in place.
--
-- Tenancy: organization-only (organizationId is required and there is no
-- userId owner; updatedById is attribution). RLS policy `org_only` on
-- report_template_override is managed by apply-rls-direct.ts (deploy:rls).
-- projectId is checked by the API to belong to the same organization.

-- CreateTable
CREATE TABLE "report_template_override" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "parameterDefaults" JSONB,
    "context" JSONB,
    "schedule" JSONB,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_template_override_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_template_override_scope_key" ON "report_template_override"("templateId", "organizationId", "projectId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "report_template_override_organizationId_idx" ON "report_template_override"("organizationId");

-- CreateIndex
CREATE INDEX "report_template_override_projectId_idx" ON "report_template_override"("projectId");

-- AddForeignKey
ALTER TABLE "report_template_override" ADD CONSTRAINT "report_template_override_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "report_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_template_override" ADD CONSTRAINT "report_template_override_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_template_override" ADD CONSTRAINT "report_template_override_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
