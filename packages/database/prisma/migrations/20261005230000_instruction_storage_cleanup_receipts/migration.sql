-- Durable object-cleanup receipts for deleted Coding Instructions snapshots.
--
-- Snapshot rows must disappear before their objects: a published-pointer or
-- derived-snapshot race can still refuse the row deletion, and removing bytes
-- first would break the surviving version. That leaves a crash/failure window
-- after a successful row delete where no remaining row can rediscover its
-- staging, promoted, and export prefixes. This independent receipt commits in
-- the SAME transaction as that row deletion and stays until the bounded
-- storage reaper has emptied every owned prefix.
--
-- There are intentionally no foreign keys. The receipt must outlive the
-- snapshot and project it names, including a project deletion; its
-- organization id is a scalar tenant boundary for RLS, not a cascading
-- relation. It stores no object key or content: the three canonical prefixes
-- derive from the immutable snapshot/project identity.
CREATE TABLE "project_instruction_pending_storage_cleanup" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_instruction_pending_storage_cleanup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_instruction_pending_storage_cleanup_snapshotId_key"
ON "project_instruction_pending_storage_cleanup"("snapshotId");

CREATE INDEX "project_instruction_pending_storage_cleanup_organizationId_idx"
ON "project_instruction_pending_storage_cleanup"("organizationId");

CREATE INDEX "project_instruction_pending_storage_cleanup_projectId_idx"
ON "project_instruction_pending_storage_cleanup"("projectId");

CREATE INDEX "project_instruction_pending_storage_cleanup_due_idx"
ON "project_instruction_pending_storage_cleanup"("nextAttemptAt", "createdAt");
