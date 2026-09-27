-- Member proposal branches (Fizzy #2738 spec §4.1, §4.6 step 1).
--
-- Three new, empty tables (branch, permanent ref reservation, push journal)
-- with their enums and indexes, the partial unique index that allows one
-- accepting branch per member and project, the member-wide intent-order
-- sequence, and the snapshot's new columns and CHECKs.
--
-- Additive, no backfill. Every new snapshot column is nullable or carries a
-- constant default, so each ADD COLUMN is metadata-only on Postgres 11+.
--
-- The snapshot table is populated, so its new CHECKs and its foreign key to
-- the branch table are added NOT VALID: Postgres enforces a NOT VALID CHECK
-- and foreign key on every insert and update from this migration on, and only
-- skips the scan of existing rows under this migration's ACCESS EXCLUSIVE
-- lock. Every existing row has NULL in every new column (proposalAssignment
-- defaults to 0 and no CHECK reads it), so each holds trivially.
-- 20260927100300_instruction_snapshot_proposal_branch_validate validates them
-- under the weaker SHARE UPDATE EXCLUSIVE lock in this same changeset, so no
-- pending-constraint-validations.json entry is owed.
--
-- The two snapshot indexes need CONCURRENTLY and therefore their own
-- single-statement migrations (20260927100100, 20260927100200).
--
-- RLS: scripts/apply-rls-direct.ts registers all three tables (branch
-- user_owned; reservation and journal org_only), and src/tenant-db.ts
-- registers the three models.

-- CreateEnum
CREATE TYPE "ProjectInstructionProposalBranchState" AS ENUM ('PENDING', 'OPENING', 'OPEN', 'CLOSE_REQUESTED', 'BLOCKED', 'MERGED', 'CLOSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ProjectInstructionProposalBranchOpKind" AS ENUM ('APPEND', 'REVERT');

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN     "pendingCommand" TEXT,
ADD COLUMN     "pendingCommandSeq" INTEGER,
ADD COLUMN     "proposalAssignment" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "proposalBranchId" TEXT,
ADD COLUMN     "proposalBranchSequence" INTEGER,
ADD COLUMN     "proposalIntentOrder" BIGINT,
ADD COLUMN     "withdrawRequestedAt" TIMESTAMP(3),
ADD COLUMN     "withdrawScope" TEXT;

-- CreateTable
CREATE TABLE "project_instruction_proposal_branch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryKey" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "ref" TEXT NOT NULL,
    "state" "ProjectInstructionProposalBranchState" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "destination" JSONB NOT NULL,
    "presentation" JSONB,
    "startSha" TEXT,
    "headSha" TEXT,
    "foreignTipAt" TIMESTAMP(3),
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "nextExecutionSeq" INTEGER NOT NULL DEFAULT 1,
    "headExecutionSeq" INTEGER NOT NULL DEFAULT 0,
    "factsRevision" INTEGER NOT NULL DEFAULT 0,
    "closeIntent" TEXT,
    "createIssuedAt" TIMESTAMP(3),
    "pullRequestUrl" TEXT,
    "pullRequestExternalId" TEXT,
    "pullRequestObservation" JSONB,
    "membership" JSONB,
    "failure" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "refreshAdmittedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "confirmationDueAt" TIMESTAMP(3),
    "mergeSyncRequestedAt" TIMESTAMP(3),
    "mergeSyncDispatchedAt" TIMESTAMP(3),
    "mergeSyncRunId" TEXT,
    "mergeSyncExpected" JSONB,
    "retiredAt" TIMESTAMP(3),
    "retiredReason" TEXT,
    "retryRequestedAt" TIMESTAMP(3),
    "untracked" BOOLEAN NOT NULL DEFAULT false,
    "settlementPhase" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_instruction_proposal_branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_instruction_proposal_ref_reservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryKey" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_instruction_proposal_ref_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_instruction_proposal_branch_operation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "kind" "ProjectInstructionProposalBranchOpKind" NOT NULL,
    "executionSeq" INTEGER NOT NULL,
    "ref" TEXT NOT NULL,
    "assignment" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "parentSha" TEXT,
    "sha" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "pushIssuedAt" TIMESTAMP(3),
    "pushAckedAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "membership" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_instruction_proposal_branch_operation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_instruction_proposal_branch_organizationId_idx" ON "project_instruction_proposal_branch"("organizationId");

-- CreateIndex
CREATE INDEX "project_instruction_proposal_branch_state_nextAttemptAt_idx" ON "project_instruction_proposal_branch"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "project_instruction_proposal_branch_confirmationDueAt_idx" ON "project_instruction_proposal_branch"("confirmationDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "project_instruction_proposal_branch_projectId_userId_number_key" ON "project_instruction_proposal_branch"("projectId", "userId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "project_instruction_proposal_branch_repositoryKey_ref_key" ON "project_instruction_proposal_branch"("repositoryKey", "ref");

-- CreateIndex
CREATE INDEX "project_instruction_proposal_ref_reservation_organizationId_idx" ON "project_instruction_proposal_ref_reservation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_instruction_proposal_ref_reservation_ref_key" ON "project_instruction_proposal_ref_reservation"("repositoryKey", "ref");

-- CreateIndex
CREATE INDEX "project_instruction_proposal_branch_op_org_idx" ON "project_instruction_proposal_branch_operation"("organizationId");

-- CreateIndex
CREATE INDEX "project_instruction_proposal_branch_op_snapshot_idx" ON "project_instruction_proposal_branch_operation"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "project_instruction_proposal_branch_op_seq_key" ON "project_instruction_proposal_branch_operation"("branchId", "executionSeq");

-- AddForeignKey
ALTER TABLE "project_instruction_proposal_branch" ADD CONSTRAINT "project_instruction_proposal_branch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_proposal_branch_operation" ADD CONSTRAINT "project_instruction_proposal_branch_operation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "project_instruction_proposal_branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One accepting branch per member and project (spec Decision 2). Prisma
-- cannot express a partial index; the schema documents it on the model. The
-- table is created above, so a plain build is instantaneous.
CREATE UNIQUE INDEX "project_instruction_proposal_branch_accepting_key"
  ON "project_instruction_proposal_branch" ("projectId", "userId")
  WHERE "retiredAt" IS NULL AND NOT "untracked"
    AND "state" IN ('PENDING', 'OPENING', 'OPEN', 'BLOCKED');

-- Member-wide intent order (spec Decision 8): proposalIntentOrder.
CREATE SEQUENCE "project_instruction_proposal_intent_seq" AS BIGINT START 1;

-- CHECKs on the new tables (empty, so validating is free).
ALTER TABLE "project_instruction_proposal_branch" ADD CONSTRAINT "project_instruction_proposal_branch_close_intent" CHECK ("closeIntent" IS NULL OR "closeIntent" IN ('WITHDRAW', 'START_OVER'));
ALTER TABLE "project_instruction_proposal_branch" ADD CONSTRAINT "project_instruction_proposal_branch_settlement_phase" CHECK ("settlementPhase" IS NULL OR "settlementPhase" IN ('deleted', 'recorded'));
ALTER TABLE "project_instruction_proposal_branch" ADD CONSTRAINT "project_instruction_proposal_branch_retired_reason" CHECK ("retiredReason" IS NULL OR "retiredReason" IN ('CONFIGURATION_CHANGED', 'BRANCH_MISSING'));
ALTER TABLE "project_instruction_proposal_ref_reservation" ADD CONSTRAINT "project_instruction_proposal_ref_reservation_status" CHECK ("status" IN ('current', 'refused', 'retired'));
ALTER TABLE "project_instruction_proposal_branch_operation" ADD CONSTRAINT "project_instruction_proposal_branch_operation_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('acked', 'observed', 'not_pushed', 'unknown'));
ALTER TABLE "project_instruction_proposal_branch_operation" ADD CONSTRAINT "project_instruction_proposal_branch_operation_membership" CHECK ("membership" IS NULL OR "membership" IN ('included', 'unverified'));

-- Snapshot CHECKs (spec §4.1). Every implication is null-safe, so a NULL
-- operand can never make a violating row pass. NOT VALID: see the header.
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_withdraw_pair" CHECK (("withdrawRequestedAt" IS NULL) = ("withdrawScope" IS NULL)) NOT VALID;
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_withdraw_scope" CHECK ("withdrawScope" IS NULL OR "withdrawScope" IN ('change', 'branch')) NOT VALID;
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_pending_command_pair" CHECK (("pendingCommand" IS NULL) = ("pendingCommandSeq" IS NULL)) NOT VALID;
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_pending_command_kind" CHECK ("pendingCommand" IS NULL OR "pendingCommand" IN ('APPEND', 'WITHDRAW')) NOT VALID;
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_pending_withdraw_scope" CHECK ("pendingCommand" IS DISTINCT FROM 'WITHDRAW' OR "withdrawScope" IS NOT DISTINCT FROM 'change') NOT VALID;
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_pending_append_intent" CHECK ("pendingCommand" IS DISTINCT FROM 'APPEND' OR "withdrawRequestedAt" IS NULL) NOT VALID;

-- AddForeignKey (NOT VALID: see the header). SET NULL: only a project cascade
-- deletes a branch, and it deletes the snapshots with it.
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_proposalBranchId_fkey" FOREIGN KEY ("proposalBranchId") REFERENCES "project_instruction_proposal_branch"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
