-- AlterEnum
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE 'DATABRICKS_PLATFORM';

-- CreateTable
CREATE TABLE "project_context_quality_principal" (
    "fingerprint" VARCHAR(64) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_context_quality_principal_pkey" PRIMARY KEY ("fingerprint")
);

-- CreateTable
CREATE TABLE "project_context_quality_binding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "workspaceOrigin" VARCHAR(512) NOT NULL,
    "jobId" VARCHAR(32) NOT NULL,
    "experimentId" VARCHAR(32) NOT NULL,
    "volumeRoot" VARCHAR(512) NOT NULL,
    "notebookPath" VARCHAR(768) NOT NULL,
    "notebookSha256" VARCHAR(64) NOT NULL,
    "principalFingerprint" VARCHAR(64) NOT NULL,
    "configHash" VARCHAR(64) NOT NULL,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "exportApprovedAt" TIMESTAMP(3),
    "exportApprovedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_quality_binding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_context_quality_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "sourceRefsJson" JSONB NOT NULL,
    "snapshotPayload" TEXT,
    "payloadHash" VARCHAR(64) NOT NULL,
    "snapshotHash" VARCHAR(64) NOT NULL,
    "scorerVersion" VARCHAR(128) NOT NULL,
    "bindingConfigJson" JSONB NOT NULL,
    "bindingConfigHash" VARCHAR(64) NOT NULL,
    "localResultJson" JSONB NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "workflowId" VARCHAR(256) NOT NULL,
    "dispatchToken" VARCHAR(64) NOT NULL,
    "remoteRunId" VARCHAR(32),
    "remoteMlflowRunId" VARCHAR(64),
    "remoteState" VARCHAR(64),
    "providerReceiptJson" JSONB,
    "resultJson" JSONB,
    "errorCode" VARCHAR(64),
    "remoteInputPath" VARCHAR(768),
    "cleanupStatus" VARCHAR(32) NOT NULL DEFAULT 'NOT_REQUIRED',
    "cleanupErrorCode" VARCHAR(64),
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "snapshotExpiresAt" TIMESTAMP(3) NOT NULL,
    "snapshotPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_quality_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_context_quality_principal_organizationId_idx" ON "project_context_quality_principal"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "context_quality_principal_fingerprint_org_key" ON "project_context_quality_principal"("fingerprint", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_context_quality_binding_projectId_key" ON "project_context_quality_binding"("projectId");

-- CreateIndex
CREATE INDEX "project_context_quality_binding_organizationId_idx" ON "project_context_quality_binding"("organizationId");

-- CreateIndex
CREATE INDEX "project_context_quality_binding_integrationId_idx" ON "project_context_quality_binding"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "context_quality_binding_id_project_org_key" ON "project_context_quality_binding"("id", "projectId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "context_quality_binding_workspace_job_key" ON "project_context_quality_binding"("workspaceOrigin", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "context_quality_binding_workspace_experiment_key" ON "project_context_quality_binding"("workspaceOrigin", "experimentId");

-- CreateIndex
CREATE UNIQUE INDEX "context_quality_binding_workspace_volume_key" ON "project_context_quality_binding"("workspaceOrigin", "volumeRoot");

-- CreateIndex
CREATE UNIQUE INDEX "project_context_quality_run_workflowId_key" ON "project_context_quality_run"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "project_context_quality_run_dispatchToken_key" ON "project_context_quality_run"("dispatchToken");

-- CreateIndex
CREATE INDEX "project_context_quality_run_projectId_createdAt_idx" ON "project_context_quality_run"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "project_context_quality_run_organizationId_status_idx" ON "project_context_quality_run"("organizationId", "status");

-- CreateIndex
CREATE INDEX "project_context_quality_run_status_createdAt_idx" ON "project_context_quality_run"("status", "createdAt");

-- CreateIndex
CREATE INDEX "project_context_quality_run_snapshotExpiresAt_cleanupStatus_idx" ON "project_context_quality_run"("snapshotExpiresAt", "cleanupStatus");

-- CreateIndex
CREATE INDEX "project_context_quality_run_bindingId_projectId_organizatio_idx" ON "project_context_quality_run"("bindingId", "projectId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "context_quality_run_actor_request_key" ON "project_context_quality_run"("projectId", "requestedBy", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "project_context_quality_principal" ADD CONSTRAINT "project_context_quality_principal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_quality_binding" ADD CONSTRAINT "project_context_quality_binding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_quality_binding" ADD CONSTRAINT "project_context_quality_binding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_quality_binding" ADD CONSTRAINT "project_context_quality_binding_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "workflow_integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_quality_binding" ADD CONSTRAINT "project_context_quality_binding_principalFingerprint_organ_fkey" FOREIGN KEY ("principalFingerprint", "organizationId") REFERENCES "project_context_quality_principal"("fingerprint", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_quality_run" ADD CONSTRAINT "project_context_quality_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_quality_run" ADD CONSTRAINT "project_context_quality_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_quality_run" ADD CONSTRAINT "project_context_quality_run_bindingId_projectId_organizati_fkey" FOREIGN KEY ("bindingId", "projectId", "organizationId") REFERENCES "project_context_quality_binding"("id", "projectId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Bounded private input and closed lifecycle/cleanup receipts. These constraints
-- deliberately live in SQL because Prisma has no CHECK-constraint schema DSL.
ALTER TABLE "project_context_quality_principal"
  ADD CONSTRAINT "context_quality_principal_hash_check" CHECK ("fingerprint" ~ '^[a-f0-9]{64}$');
ALTER TABLE "project_context_quality_binding"
  ADD CONSTRAINT "context_quality_binding_hash_check" CHECK (
    "notebookSha256" ~ '^[a-f0-9]{64}$' AND "principalFingerprint" ~ '^[a-f0-9]{64}$' AND "configHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "context_quality_binding_approval_check" CHECK (NOT "isEnabled" OR ("exportApprovedAt" IS NOT NULL AND "exportApprovedBy" IS NOT NULL)),
  ADD CONSTRAINT "context_quality_binding_version_check" CHECK ("configVersion" > 0);
ALTER TABLE "project_context_quality_run"
  ADD CONSTRAINT "context_quality_run_status_check" CHECK ("status" IN ('QUEUED','EXPORTING','DISPATCHING','RUNNING','CANCEL_REQUESTED','SUCCEEDED','FAILED','CANCELLED','RECONCILIATION_REQUIRED')),
  ADD CONSTRAINT "context_quality_run_cleanup_check" CHECK ("cleanupStatus" IN ('NOT_REQUIRED','PENDING','CONFIRMED','BLOCKED')),
  ADD CONSTRAINT "context_quality_run_hash_check" CHECK (
    "requestHash" ~ '^[a-f0-9]{64}$' AND "payloadHash" ~ '^[a-f0-9]{64}$' AND "snapshotHash" ~ '^[a-f0-9]{64}$' AND "bindingConfigHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "context_quality_run_payload_check" CHECK (octet_length("snapshotPayload") <= 131072),
  ADD CONSTRAINT "context_quality_run_expiry_check" CHECK ("deadlineAt" <= "snapshotExpiresAt"),
  ADD CONSTRAINT "context_quality_run_version_check" CHECK ("stateVersion" >= 0);
