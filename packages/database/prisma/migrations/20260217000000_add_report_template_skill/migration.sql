-- CreateTable
CREATE TABLE "report_template_skill" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_template_skill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_template_skill_templateId_idx" ON "report_template_skill"("templateId");

-- CreateIndex
CREATE INDEX "report_template_skill_skillId_idx" ON "report_template_skill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "report_template_skill_templateId_skillId_key" ON "report_template_skill"("templateId", "skillId");

-- AddForeignKey
ALTER TABLE "report_template_skill" ADD CONSTRAINT "report_template_skill_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "report_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;
