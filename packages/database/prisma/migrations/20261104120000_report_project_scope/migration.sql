-- Report suite: a report can belong to a project, and a report template can be
-- archived.
--
-- template_instance.projectId ties a report to the project whose Reports tab
-- owns it, so the project's editors can maintain it. Deleting the project
-- keeps the report and clears the link. Existing reports keep NULL.
--
-- report_template.archivedAt hides a template from template pickers without
-- touching the reports already created from it.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: template_instance keeps its existing `user_owned` RLS policy
-- (scripts/apply-rls-direct.ts); projectId is not a tenant column and points
-- at a project inside the same organization, which the API checks on write.

-- AlterTable
ALTER TABLE "template_instance" ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "report_template" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AddForeignKey (validated in 20261104120030, indexed in 20261104120100, so the
-- table is not locked while existing rows are scanned)
ALTER TABLE "template_instance" ADD CONSTRAINT "template_instance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
