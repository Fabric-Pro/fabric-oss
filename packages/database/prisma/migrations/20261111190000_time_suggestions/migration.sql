-- Time tracking: suggestions a member confirms or dismisses, built on demand
-- from their own activity.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: the three new tables carry "organizationId" and "userId" and take
-- the `user_owned` RLS policy (scripts/apply-rls-direct.ts), like time_entry.
-- The queries narrow every read and write to the owner by "userId".
--
-- time_entry gains one nullable column with no default, which Postgres records
-- in the catalog without rewriting the table; the previous app version never
-- reads it. Its unique index is built CONCURRENTLY in the next migration,
-- 20261111190100_index_time_entry_source_suggestion.

-- CreateEnum
CREATE TYPE "TimeSuggestionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "TimeEvidenceKind" AS ENUM ('MEETING_SESSION', 'TEST_RUN', 'FEATURE_EDIT', 'TEST_RESULT', 'TEST_CASE_ACTIVITY');

-- CreateEnum
CREATE TYPE "TimeSuggestionRunStatus" AS ENUM ('GENERATING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "time_entry" ADD COLUMN "sourceSuggestionId" TEXT;

-- CreateTable
CREATE TABLE "time_suggestion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "activity" "TimeActivity" NOT NULL,
    "billable" BOOLEAN,
    "durationMinutes" INTEGER,
    "startAt" TIMESTAMPTZ(3),
    "stopAt" TIMESTAMPTZ(3),
    "description" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "storyId" TEXT,
    "storyIdentifier" TEXT,
    "storyTitle" TEXT,
    "status" "TimeSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "confirmedEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_suggestion_evidence" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "TimeEvidenceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "startAt" TIMESTAMPTZ(3),
    "endAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_suggestion_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_suggestion_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "TimeSuggestionRunStatus" NOT NULL DEFAULT 'GENERATING',
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "time_suggestion_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "time_suggestion_confirmedEntryId_key" ON "time_suggestion"("confirmedEntryId");

-- CreateIndex
CREATE INDEX "time_suggestion_userId_organizationId_status_workDate_idx" ON "time_suggestion"("userId", "organizationId", "status", "workDate");

-- CreateIndex
CREATE INDEX "time_suggestion_projectId_idx" ON "time_suggestion"("projectId");

-- CreateIndex
CREATE INDEX "time_suggestion_storyId_idx" ON "time_suggestion"("storyId");

-- CreateIndex
CREATE INDEX "time_suggestion_evidence_suggestionId_idx" ON "time_suggestion_evidence"("suggestionId");

-- CreateIndex
CREATE UNIQUE INDEX "time_suggestion_evidence_userId_kind_sourceId_key" ON "time_suggestion_evidence"("userId", "kind", "sourceId");

-- CreateIndex
CREATE INDEX "time_suggestion_run_organizationId_userId_startedAt_idx" ON "time_suggestion_run"("organizationId", "userId", "startedAt");

-- CreateIndex
CREATE INDEX "time_suggestion_run_userId_idx" ON "time_suggestion_run"("userId");

-- AddForeignKey
ALTER TABLE "time_suggestion" ADD CONSTRAINT "time_suggestion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_suggestion" ADD CONSTRAINT "time_suggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_suggestion" ADD CONSTRAINT "time_suggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_suggestion" ADD CONSTRAINT "time_suggestion_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_suggestion_evidence" ADD CONSTRAINT "time_suggestion_evidence_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "time_suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_suggestion_run" ADD CONSTRAINT "time_suggestion_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_suggestion_run" ADD CONSTRAINT "time_suggestion_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- What Prisma cannot express.
-- ---------------------------------------------------------------------------

-- In-flight guard: at most ONE generating run per member and organization.
-- The index is the enforcement; the read in `startTimeSuggestionRun` only
-- turns the race into an "in progress" answer instead of a constraint error.
-- Mirrors `publishing_topic_planning_analysis_active`.
CREATE UNIQUE INDEX "time_suggestion_run_active"
    ON "time_suggestion_run" ("organizationId", "userId")
    WHERE "status" = 'GENERATING';

-- A suggestion's start and stop are given together or not at all, the rule
-- the time-tracking procedures apply to time_entry.
ALTER TABLE "time_suggestion"
    ADD CONSTRAINT "time_suggestion_start_stop_together"
    CHECK (("startAt" IS NULL) = ("stopAt" IS NULL));
