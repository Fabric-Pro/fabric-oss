-- CreateTable
CREATE TABLE "weave_plan_template" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "checkboxes" JSONB NOT NULL,
    "message" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weave_plan_template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weave_plan_template_userId_organizationId_idx" ON "weave_plan_template"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "weave_plan_template_projectId_idx" ON "weave_plan_template"("projectId");
