-- CreateEnum
CREATE TYPE "context_summary_status" AS ENUM ('PENDING', 'GENERATING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "context_summary_trigger" AS ENUM ('AUTO', 'MANUAL');

-- CreateTable
CREATE TABLE "project_context_summary" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "context_summary_status" NOT NULL DEFAULT 'PENDING',
    "trigger" "context_summary_trigger" NOT NULL,
    "coveredThrough" TIMESTAMP(3) NOT NULL,
    "coveredContextCount" INTEGER NOT NULL DEFAULT 0,
    "tokenCount" INTEGER,
    "model" TEXT,
    "error" TEXT,
    "triggeredByUserId" TEXT,
    "qdrantId" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_context_summary_projectId_status_idx" ON "project_context_summary"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_context_summary_projectId_createdAt_idx" ON "project_context_summary"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "project_context_summary_userId_idx" ON "project_context_summary"("userId");

-- CreateIndex
CREATE INDEX "project_context_summary_organizationId_idx" ON "project_context_summary"("organizationId");

-- CreateIndex
CREATE INDEX "project_context_summary_qdrantId_idx" ON "project_context_summary"("qdrantId");

-- AddForeignKey
ALTER TABLE "project_context_summary" ADD CONSTRAINT "project_context_summary_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_summary" ADD CONSTRAINT "project_context_summary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_summary" ADD CONSTRAINT "project_context_summary_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

