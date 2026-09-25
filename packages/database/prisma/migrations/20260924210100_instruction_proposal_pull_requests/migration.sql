-- Coding Instructions proposal pull requests (Fizzy #2563 spec §4.1, §4.5
-- step 2).
--
-- Two new enum types, MERGED and CLOSED on the proposal status, the snapshot's
-- pull-request columns and the sync row's reader opt-in. Additive and with no
-- backfill: every existing row reads as a FABRIC proposal (or no proposal)
-- with no pull-request operation. Each NOT NULL column carries a constant
-- default and every other column is nullable, so every ADD COLUMN is
-- metadata-only in Postgres 11+ and takes no table rewrite.
--
-- MERGED and CLOSED are not used in this file: a value added by ALTER TYPE
-- cannot be referenced in the transaction that adds it.
--
-- No index here. Each index on the existing snapshot table needs
-- CONCURRENTLY and therefore its own single-statement migration
-- (20260924120200, 20260924120300, 20260924120400).
--
-- No new table, so no RLS or tenant-extension change: the snapshot and sync
-- tables are already registered (scripts/apply-rls-direct.ts, src/tenant-db.ts)
-- and their policies apply to new columns.

-- CreateEnum
CREATE TYPE "ProjectInstructionProposalDestination" AS ENUM ('FABRIC', 'REPOSITORY');

-- CreateEnum
CREATE TYPE "ProjectInstructionPullRequestState" AS ENUM ('QUEUED', 'OPENING', 'OPEN', 'CLOSE_REQUESTED', 'MERGED', 'CLOSED', 'BLOCKED', 'CANCELED');

-- AlterEnum
ALTER TYPE "ProjectInstructionProposalStatus" ADD VALUE 'MERGED';

-- AlterEnum
ALTER TYPE "ProjectInstructionProposalStatus" ADD VALUE 'CLOSED';

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN     "mergeSyncDispatchedAt" TIMESTAMP(3),
ADD COLUMN     "mergeSyncExpected" JSONB,
ADD COLUMN     "mergeSyncRequestedAt" TIMESTAMP(3),
ADD COLUMN     "mergeSyncRunId" TEXT,
ADD COLUMN     "proposalDestination" "ProjectInstructionProposalDestination" NOT NULL DEFAULT 'FABRIC',
ADD COLUMN     "proposalNote" JSONB,
ADD COLUMN     "pullRequestAttempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pullRequestAttempts" JSONB[] DEFAULT ARRAY[]::JSONB[],
ADD COLUMN     "pullRequestConfirmationDueAt" TIMESTAMP(3),
ADD COLUMN     "pullRequestContext" JSONB,
ADD COLUMN     "pullRequestExternalId" TEXT,
ADD COLUMN     "pullRequestFailure" JSONB,
ADD COLUMN     "pullRequestHeadSha" TEXT,
ADD COLUMN     "pullRequestLastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "pullRequestNextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "pullRequestObligationOpen" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pullRequestObservation" JSONB,
ADD COLUMN     "pullRequestOperationId" TEXT,
ADD COLUMN     "pullRequestRef" TEXT,
ADD COLUMN     "pullRequestState" "ProjectInstructionPullRequestState",
ADD COLUMN     "pullRequestUrl" TEXT;

-- AlterTable
ALTER TABLE "project_instruction_repository_sync" ADD COLUMN     "allowReaderProposals" BOOLEAN NOT NULL DEFAULT false;
