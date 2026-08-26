-- AlterTable
ALTER TABLE "agent_memory_file" ADD COLUMN     "isEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sourceSkillId" TEXT;

-- CreateTable
CREATE TABLE "skill" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope" "AgentTemplateScope" NOT NULL DEFAULT 'SYSTEM',
    "userId" TEXT,
    "organizationId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_template_skill" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_template_skill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skill_scope_idx" ON "skill"("scope");

-- CreateIndex
CREATE INDEX "skill_userId_idx" ON "skill"("userId");

-- CreateIndex
CREATE INDEX "skill_organizationId_idx" ON "skill"("organizationId");

-- CreateIndex
CREATE INDEX "skill_category_idx" ON "skill"("category");

-- CreateIndex
CREATE INDEX "skill_isPublished_idx" ON "skill"("isPublished");

-- CreateIndex
CREATE UNIQUE INDEX "skill_slug_scope_userId_organizationId_key" ON "skill"("slug", "scope", "userId", "organizationId");

-- CreateIndex
CREATE INDEX "agent_template_skill_templateId_idx" ON "agent_template_skill"("templateId");

-- CreateIndex
CREATE INDEX "agent_template_skill_skillId_idx" ON "agent_template_skill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_template_skill_templateId_skillId_key" ON "agent_template_skill"("templateId", "skillId");

-- CreateIndex
CREATE INDEX "agent_memory_file_sourceSkillId_idx" ON "agent_memory_file"("sourceSkillId");

-- AddForeignKey
ALTER TABLE "agent_memory_file" ADD CONSTRAINT "agent_memory_file_sourceSkillId_fkey" FOREIGN KEY ("sourceSkillId") REFERENCES "skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill" ADD CONSTRAINT "skill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill" ADD CONSTRAINT "skill_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_template_skill" ADD CONSTRAINT "agent_template_skill_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "agent_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_template_skill" ADD CONSTRAINT "agent_template_skill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (created here because skill table is created in this migration)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'report_template_skill'
    ) AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'report_template_skill_skillId_fkey'
    ) THEN
        ALTER TABLE "report_template_skill"
            ADD CONSTRAINT "report_template_skill_skillId_fkey"
            FOREIGN KEY ("skillId") REFERENCES "skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
