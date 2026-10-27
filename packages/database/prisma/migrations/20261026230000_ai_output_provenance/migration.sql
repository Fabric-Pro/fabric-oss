-- CreateTable
CREATE TABLE "ai_output_provenance" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "agentId" TEXT,
    "modelCanonicalName" TEXT,
    "promptVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_output_provenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_output_provenance_userId_idx" ON "ai_output_provenance"("userId");

-- CreateIndex
CREATE INDEX "ai_output_provenance_projectId_idx" ON "ai_output_provenance"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_output_provenance_subject_key" ON "ai_output_provenance"("organizationId", "userId", "subjectType", "subjectId");

-- AddForeignKey
ALTER TABLE "ai_output_provenance" ADD CONSTRAINT "ai_output_provenance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_output_provenance" ADD CONSTRAINT "ai_output_provenance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_output_provenance" ADD CONSTRAINT "ai_output_provenance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
