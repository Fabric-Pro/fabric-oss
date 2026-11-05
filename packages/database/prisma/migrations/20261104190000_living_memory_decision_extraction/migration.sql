-- Decisions extracted from synced Living Memory files, offered in the
-- project's Decisions tab as review candidates.
--
-- `project_context_decision_extraction` holds one row per (context, content
-- version) the embedding confirmed: the decisions an AI found in that version
-- (an empty array when it found none), the positions a reviewer dismissed, and
-- `notifiedAt`, the at-most-once claim for the notification below. Deleting a
-- context deletes its rows (ON DELETE CASCADE).
--
-- `DECISION_CANDIDATES_READY` tells the people who can create decisions on the
-- project that new candidates wait for review. Category PROJECT, which already
-- maps to the `syncProject` preference toggle, so no new setting is needed.
--
-- ALTER TYPE ... ADD VALUE is a one-way door: it does not roll back. Safe
-- inside the migration transaction on PostgreSQL 12+, because nothing here
-- uses the new value.
--
-- Additive and idempotent: one enum value and one new, empty table with its
-- indexes and foreign key. No backfill.
--
-- RLS: scripts/apply-rls-direct.ts registers the table (user_owned), and
-- src/tenant-db.ts registers the model.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DECISION_CANDIDATES_READY';

-- CreateTable
CREATE TABLE IF NOT EXISTS "project_context_decision_extraction" (
    "id" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "dismissedIndexes" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "model" TEXT,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_decision_extraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "project_context_decision_extraction_contextId_contentHash_key" ON "project_context_decision_extraction"("contextId", "contentHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_context_decision_extraction_projectId_idx" ON "project_context_decision_extraction"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_context_decision_extraction_userId_idx" ON "project_context_decision_extraction"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_context_decision_extraction_organizationId_idx" ON "project_context_decision_extraction"("organizationId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'project_context_decision_extraction_contextId_fkey'
    ) THEN
        ALTER TABLE "project_context_decision_extraction" ADD CONSTRAINT "project_context_decision_extraction_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "project_context"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
