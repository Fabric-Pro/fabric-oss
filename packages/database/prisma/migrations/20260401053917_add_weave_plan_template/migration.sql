-- AlterTable
ALTER TABLE "weave_plan_template" ALTER COLUMN "message" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "weave_plan_template_category_idx" ON "weave_plan_template"("category");
