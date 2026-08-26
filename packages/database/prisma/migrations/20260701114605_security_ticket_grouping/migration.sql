-- NOTE: `prisma migrate diff` also emitted two pre-existing drift artifacts on
-- unrelated tables (a partial-vs-plain `mcp_server_default_enabled_idx`, and a
-- `coding_run_status_startedAt_idx` casing rename) — the same known drift
-- documented in `20260618120000_feature_maturation_v2/migration.sql` and
-- `20260523172126_add_context_indexing_notification_categories/migration.sql`.
-- Those are NOT part of this feature and are intentionally excluded so this
-- migration is a single focused change (`migrations.md`).

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SECURITY_TICKETS_GENERATED';

-- AlterEnum
ALTER TYPE "ScanActivityType" ADD VALUE 'FINDINGS_GROUPED';

-- AlterTable
ALTER TABLE "project_scan_config" ADD COLUMN     "agentTicketGenerationEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "scan_finding_grouping" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "scanId" TEXT,
    "status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "results" JSONB,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "themeCount" INTEGER NOT NULL DEFAULT 0,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "modelName" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "durationMs" INTEGER,
    "error" TEXT,
    "workflowId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scan_finding_grouping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_finding_grouping_projectId_createdAt_idx" ON "scan_finding_grouping"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "scan_finding_grouping_userId_idx" ON "scan_finding_grouping"("userId");

-- CreateIndex
CREATE INDEX "scan_finding_grouping_organizationId_idx" ON "scan_finding_grouping"("organizationId");

-- CreateIndex
CREATE INDEX "scan_activity_storyId_createdAt_idx" ON "scan_activity"("storyId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "scan_finding_grouping" ADD CONSTRAINT "scan_finding_grouping_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding_grouping" ADD CONSTRAINT "scan_finding_grouping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding_grouping" ADD CONSTRAINT "scan_finding_grouping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
