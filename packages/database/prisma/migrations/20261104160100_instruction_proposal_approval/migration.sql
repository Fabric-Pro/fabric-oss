-- Per-reviewer approvals of upload-mode Coding Instructions file proposals.
-- A proposal publishes once the project's review policy
-- (`instructionSettings.reviewPolicy.requiredApprovals`, default 1) counts
-- enough rows here. Repository-mode proposals are decided on their pull
-- request and never write a row.
--
-- Additive: one new table with its indexes and foreign keys. The table is
-- new and empty when the indexes are built, so CONCURRENTLY is not needed.
--
-- RLS: scripts/apply-rls-direct.ts registers the table (user_owned), and
-- src/tenant-db.ts registers the model.

-- CreateTable
CREATE TABLE "project_instruction_proposal_approval" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_instruction_proposal_approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_instruction_proposal_approval_projectId_idx" ON "project_instruction_proposal_approval"("projectId");

-- CreateIndex
CREATE INDEX "project_instruction_proposal_approval_organizationId_idx" ON "project_instruction_proposal_approval"("organizationId");

-- CreateIndex
CREATE INDEX "project_instruction_proposal_approval_userId_idx" ON "project_instruction_proposal_approval"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_instruction_proposal_approval_snapshotId_userId_key" ON "project_instruction_proposal_approval"("snapshotId", "userId");

-- AddForeignKey
ALTER TABLE "project_instruction_proposal_approval" ADD CONSTRAINT "project_instruction_proposal_approval_snapshotId_projectId_fkey" FOREIGN KEY ("snapshotId", "projectId") REFERENCES "project_instruction_snapshot"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_proposal_approval" ADD CONSTRAINT "project_instruction_proposal_approval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_proposal_approval" ADD CONSTRAINT "project_instruction_proposal_approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every upload-mode proposal approved before this table existed was
-- approved by one reviewer, its `reviewerUserId`. One row each, so the review
-- card reads "1 of 1" for it. Idempotent through the unique index. A row whose
-- reviewer was deleted (`reviewerUserId` set null) has no one to record.
INSERT INTO "project_instruction_proposal_approval" ("id", "snapshotId", "projectId", "organizationId", "userId", "createdAt")
SELECT gen_random_uuid()::text, s."id", s."projectId", s."organizationId", s."reviewerUserId", COALESCE(s."reviewedAt", s."updatedAt")
FROM "project_instruction_snapshot" s
WHERE s."proposalStatus" = 'APPROVED'
    AND s."proposalDestination" = 'FABRIC'
    AND s."reviewerUserId" IS NOT NULL
ON CONFLICT ("snapshotId", "userId") DO NOTHING;
