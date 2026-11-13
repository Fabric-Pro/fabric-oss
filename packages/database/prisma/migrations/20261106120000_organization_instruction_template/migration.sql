-- An organization can name one of its projects as the template for coding
-- instructions: its other projects can start from that project's published
-- files.
--
-- Nullable, no default, no backfill: no organization has a template until an
-- admin or owner chooses one. Deleting the project clears the setting
-- (ON DELETE SET NULL). The API checks on write that the project belongs to
-- the same organization.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: `organization` keeps its existing RLS policies; the new column is
-- not a tenant column.

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "instructionTemplateProjectId" TEXT;

-- AddForeignKey (validated in 20261106120030, indexed in 20261106120100, so the
-- table is not locked while existing rows are scanned)
ALTER TABLE "organization" ADD CONSTRAINT "organization_instructionTemplateProjectId_fkey" FOREIGN KEY ("instructionTemplateProjectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
