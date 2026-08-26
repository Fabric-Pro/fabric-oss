-- CreateTable
CREATE TABLE "project_scan_checkpoint" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "lastScanId" TEXT,
    "lastScannedAt" TIMESTAMP(3) NOT NULL,
    "changedFileCount" INTEGER,
    "changedCommitCount" INTEGER,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_scan_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_scan_checkpoint_projectId_idx" ON "project_scan_checkpoint"("projectId");

-- CreateIndex
CREATE INDEX "project_scan_checkpoint_userId_idx" ON "project_scan_checkpoint"("userId");

-- CreateIndex
CREATE INDEX "project_scan_checkpoint_organizationId_idx" ON "project_scan_checkpoint"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_scan_checkpoint_projectId_branch_key" ON "project_scan_checkpoint"("projectId", "branch");

-- AddForeignKey
ALTER TABLE "project_scan_checkpoint" ADD CONSTRAINT "project_scan_checkpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_scan_checkpoint" ADD CONSTRAINT "project_scan_checkpoint_lastScanId_fkey" FOREIGN KEY ("lastScanId") REFERENCES "project_scan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_scan_checkpoint" ADD CONSTRAINT "project_scan_checkpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_scan_checkpoint" ADD CONSTRAINT "project_scan_checkpoint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

