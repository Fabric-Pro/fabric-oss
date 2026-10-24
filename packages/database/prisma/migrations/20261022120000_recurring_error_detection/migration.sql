-- Recurring-error detection: a scheduled scan that files BUG proposals in the
-- review inbox for application errors (and open bug reports) that keep
-- recurring.
--
-- Hand-written rather than generated, like 20260819140000: `prisma migrate dev`
-- carries unrelated drift between the migration history and schema.prisma,
-- which must not ride along with this change.

-- AlterEnum
-- Neither value is referenced below: a value added by ALTER TYPE cannot be
-- used in the transaction that adds it.
ALTER TYPE "PendingBacklogProposalSource" ADD VALUE IF NOT EXISTS 'LOG_MONITOR';
ALTER TYPE "PendingBacklogProposalSource" ADD VALUE IF NOT EXISTS 'INCIDENT_CLUSTER';

-- AlterTable
-- Default OFF: no project starts reading its logs until an admin opts in.
ALTER TABLE "project"
  ADD COLUMN "autoDetectRecurringErrors" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recurringErrorThreshold" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "recurringErrorWindowHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "recurringErrorLastScanAt" TIMESTAMP(3),
  ADD COLUMN "recurringErrorLastScanError" TEXT;

-- CreateEnum
CREATE TYPE "RecurringErrorSource" AS ENUM ('LOG', 'INCIDENT');

-- CreateTable
CREATE TABLE "recurring_error_signature" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" "RecurringErrorSource" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "occurrenceCount" INTEGER NOT NULL,
    "affectedUsers" INTEGER NOT NULL DEFAULT 0,
    "components" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastScanAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sampleExcerpts" JSONB,
    "sourceStoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pendingProposalId" TEXT,
    "storyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_error_signature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recurring_error_signature_projectId_source_fingerprint_key" ON "recurring_error_signature"("projectId", "source", "fingerprint");

-- CreateIndex
CREATE INDEX "recurring_error_signature_projectId_idx" ON "recurring_error_signature"("projectId");

-- AddForeignKey
ALTER TABLE "recurring_error_signature" ADD CONSTRAINT "recurring_error_signature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
