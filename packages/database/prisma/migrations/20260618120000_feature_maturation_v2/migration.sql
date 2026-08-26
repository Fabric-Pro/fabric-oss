-- Feature Maturation V2 — Three-Tab Feature Editor (spec 2026-06-09 §5).
-- Additive only: new enums, new threaded Decision Log + approval-preference
-- tables, nullable/no-touch-default columns on user_story and feature_version.
-- Clean flag-off rollback (R-6) — existing rows untouched. The Clean Spec is
-- still user_story.description + acceptanceCriteria (no cleanSpecContent).
--
-- NOTE: `prisma migrate diff` also emitted two pre-existing drift artifacts on
-- unrelated tables (a partial-vs-plain `mcp_server_default_enabled_idx`, and a
-- `coding_run_status_startedAt_idx` casing rename). Those are NOT part of this
-- feature and are intentionally excluded so this migration is a single focused
-- change (`migrations.md`).

-- CreateEnum
CREATE TYPE "maturation_approval_mode" AS ENUM ('AUTO_ACCEPT', 'MANUAL');

-- CreateEnum
CREATE TYPE "decision_author_type" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "decision_status" AS ENUM ('OPEN', 'RESOLVED', 'REJECTED', 'FORMATTING_ONLY');

-- CreateEnum
CREATE TYPE "decision_source" AS ENUM ('HUMAN', 'AI_CONFIRMED');

-- AlterTable
ALTER TABLE "feature_version" ADD COLUMN     "summaryDigestSnapshot" TEXT,
ADD COLUMN     "workingNotesSnapshot" TEXT;

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "cleanSpecApprovalMode" "maturation_approval_mode",
ADD COLUMN     "decisionLogApprovalMode" "maturation_approval_mode",
ADD COLUMN     "maturationV2OptedIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "summaryDigest" TEXT,
ADD COLUMN     "summaryQuestionsApprovalMode" "maturation_approval_mode",
ADD COLUMN     "workingNotesContent" TEXT;

-- CreateTable
CREATE TABLE "decision_log_entry" (
    "id" TEXT NOT NULL,
    "userStoryId" TEXT NOT NULL,
    "parentId" TEXT,
    "authorType" "decision_author_type" NOT NULL,
    "authorUserId" TEXT,
    "status" "decision_status" NOT NULL DEFAULT 'OPEN',
    "summary" TEXT,
    "content" TEXT,
    "impactedSection" TEXT,
    "questionId" TEXT,
    "source" "decision_source" NOT NULL DEFAULT 'HUMAN',
    "decidedBy" TEXT,
    "metadata" JSONB,
    "organizationId" TEXT,
    "userId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decision_log_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maturation_approval_preference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "cleanSpecMode" "maturation_approval_mode" NOT NULL DEFAULT 'AUTO_ACCEPT',
    "decisionLogMode" "maturation_approval_mode" NOT NULL DEFAULT 'AUTO_ACCEPT',
    "summaryQuestionsMode" "maturation_approval_mode" NOT NULL DEFAULT 'MANUAL',
    "autoAcceptAll" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maturation_approval_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decision_log_entry_userStoryId_createdAt_idx" ON "decision_log_entry"("userStoryId", "createdAt");

-- CreateIndex
CREATE INDEX "decision_log_entry_parentId_idx" ON "decision_log_entry"("parentId");

-- CreateIndex
CREATE INDEX "decision_log_entry_organizationId_idx" ON "decision_log_entry"("organizationId");

-- CreateIndex
CREATE INDEX "decision_log_entry_userId_idx" ON "decision_log_entry"("userId");

-- CreateIndex
CREATE INDEX "maturation_approval_preference_userId_idx" ON "maturation_approval_preference"("userId");

-- CreateIndex
CREATE INDEX "maturation_approval_preference_organizationId_idx" ON "maturation_approval_preference"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "maturation_approval_preference_userId_organizationId_key" ON "maturation_approval_preference"("userId", "organizationId");

-- CreateIndex
-- The Prisma `@@unique([userId, organizationId])` above does NOT constrain
-- personal-context rows: Postgres treats NULL as DISTINCT in a plain unique
-- index, so `(userId, NULL)` could be inserted repeatedly. This hand-written
-- PARTIAL unique index enforces one personal-context preference per user. Same
-- approach as `user_story`'s `*_user_story_external_id_unique` partial index;
-- Prisma can only emit plain (non-partial) `@@unique`, so this stays out of the
-- schema model and lives here. Keep both indexes — the plain one covers org rows.
CREATE UNIQUE INDEX "maturation_approval_preference_user_personal_unique" ON "maturation_approval_preference"("userId") WHERE "organizationId" IS NULL;

-- AddForeignKey
ALTER TABLE "decision_log_entry" ADD CONSTRAINT "decision_log_entry_userStoryId_fkey" FOREIGN KEY ("userStoryId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_log_entry" ADD CONSTRAINT "decision_log_entry_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "decision_log_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_log_entry" ADD CONSTRAINT "decision_log_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_log_entry" ADD CONSTRAINT "decision_log_entry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maturation_approval_preference" ADD CONSTRAINT "maturation_approval_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maturation_approval_preference" ADD CONSTRAINT "maturation_approval_preference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
