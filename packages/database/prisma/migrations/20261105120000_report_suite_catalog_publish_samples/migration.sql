-- Report suite: catalog, published prompts and stored samples.
--
-- report_template."isGeneric" marks a template that runs without any external
-- connector, so the catalog lists it before any report made from it has
-- completed. A constant DEFAULT on ADD COLUMN is a catalog-only change in
-- Postgres 11+ (no table rewrite); the report-template seed sets the flag on
-- the system templates.
--
-- report_template_override."prompts" holds an organization's default report
-- instructions and AI task prompts for the reports it creates from a template.
-- Nullable, so the previous app version keeps working without writing it.
--
-- report_template_sample stores the AI-written sample of what a template
-- produces, keyed by a hash of the exact prompt it was written from, so one
-- template shows a sample without an AI call per viewer.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change. The sample table is new and empty, so its index and
-- foreign key are built in place.
--
-- Tenancy: report_template_sample has no tenant columns. Access follows the
-- parent report_template (scope RLS policy) through the templateId FK, like
-- skill_file through skill.

-- AlterTable
ALTER TABLE "report_template" ADD COLUMN "isGeneric" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "report_template_override" ADD COLUMN "prompts" JSONB;

-- CreateTable
CREATE TABLE "report_template_sample" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_template_sample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_template_sample_templateId_contentHash_key" ON "report_template_sample"("templateId", "contentHash");

-- AddForeignKey
ALTER TABLE "report_template_sample" ADD CONSTRAINT "report_template_sample_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "report_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;
