-- CreateEnum
CREATE TYPE "DataConnectionProvider" AS ENUM ('GOOGLE_DRIVE', 'NOTION', 'CONFLUENCE', 'INTERCOM', 'GITHUB', 'MICROSOFT', 'SLACK', 'SNOWFLAKE', 'BIGQUERY', 'ZENDESK', 'GONG');

-- CreateEnum
CREATE TYPE "DataConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'SYNCING', 'ERROR', 'PAUSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('FULL', 'INCREMENTAL', 'SELECTIVE');

-- CreateEnum
CREATE TYPE "ResourceSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'DELETED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "SyncFrequency" AS ENUM ('REALTIME', 'EVERY_5_MIN', 'HOURLY', 'EVERY_8_HOURS', 'DAILY', 'WEEKLY', 'CUSTOM');

-- CreateTable
CREATE TABLE "data_connection" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "provider" "DataConnectionProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DataConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "credentials" JSONB,
    "config" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "data_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sync_job" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "type" "SyncJobType" NOT NULL DEFAULT 'FULL',
    "totalItems" INTEGER,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "stats" JSONB,
    "workflowId" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_sync_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "synced_resource" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalPath" TEXT,
    "resourceType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contentHash" TEXT,
    "metadata" JSONB,
    "workspaceId" TEXT,
    "documentId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "syncStatus" "ResourceSyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncError" TEXT,
    "sizeBytes" INTEGER,
    "textLength" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "synced_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sync_schedule" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "frequency" "SyncFrequency" NOT NULL DEFAULT 'HOURLY',
    "cronExpression" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_sync_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_connection_userId_provider_key" ON "data_connection"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "data_connection_organizationId_provider_key" ON "data_connection"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "data_connection_userId_idx" ON "data_connection"("userId");

-- CreateIndex
CREATE INDEX "data_connection_organizationId_idx" ON "data_connection"("organizationId");

-- CreateIndex
CREATE INDEX "data_connection_provider_idx" ON "data_connection"("provider");

-- CreateIndex
CREATE INDEX "data_connection_status_idx" ON "data_connection"("status");

-- CreateIndex
CREATE INDEX "data_connection_createdBy_idx" ON "data_connection"("createdBy");

-- CreateIndex
CREATE INDEX "data_sync_job_connectionId_idx" ON "data_sync_job"("connectionId");

-- CreateIndex
CREATE INDEX "data_sync_job_status_idx" ON "data_sync_job"("status");

-- CreateIndex
CREATE INDEX "data_sync_job_workflowId_idx" ON "data_sync_job"("workflowId");

-- CreateIndex
CREATE INDEX "data_sync_job_createdAt_idx" ON "data_sync_job"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "synced_resource_documentId_key" ON "synced_resource"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "synced_resource_connectionId_externalId_key" ON "synced_resource"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "synced_resource_connectionId_idx" ON "synced_resource"("connectionId");

-- CreateIndex
CREATE INDEX "synced_resource_workspaceId_idx" ON "synced_resource"("workspaceId");

-- CreateIndex
CREATE INDEX "synced_resource_documentId_idx" ON "synced_resource"("documentId");

-- CreateIndex
CREATE INDEX "synced_resource_syncStatus_idx" ON "synced_resource"("syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "data_sync_schedule_connectionId_key" ON "data_sync_schedule"("connectionId");

-- CreateIndex
CREATE INDEX "data_sync_schedule_isActive_idx" ON "data_sync_schedule"("isActive");

-- CreateIndex
CREATE INDEX "data_sync_schedule_nextRunAt_idx" ON "data_sync_schedule"("nextRunAt");

-- AddForeignKey
ALTER TABLE "data_connection" ADD CONSTRAINT "data_connection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_connection" ADD CONSTRAINT "data_connection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_connection" ADD CONSTRAINT "data_connection_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_sync_job" ADD CONSTRAINT "data_sync_job_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "data_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synced_resource" ADD CONSTRAINT "synced_resource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "data_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synced_resource" ADD CONSTRAINT "synced_resource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synced_resource" ADD CONSTRAINT "synced_resource_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "workspace_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_sync_schedule" ADD CONSTRAINT "data_sync_schedule_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "data_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
