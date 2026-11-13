-- Time tracking: a member's running timer, the segments it ran, the outcome
-- of a stopped timer, and the member's time-tracking preferences.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: time_timer, time_timer_segment and time_timer_stop carry
-- "organizationId" and "userId" and take the `user_owned` RLS policy
-- (scripts/apply-rls-direct.ts), like time_entry; the queries narrow every
-- read and write to the owner by "userId". time_tracking_preference takes
-- `per_user_within_org`, like cli_connection_prompt_dismissal.
--
-- Only new tables: no existing table is altered or indexed.

-- CreateEnum
CREATE TYPE "TimeTimerStatus" AS ENUM ('RUNNING', 'PAUSED');

-- CreateEnum
CREATE TYPE "TimeTimerStopOutcome" AS ENUM ('SAVED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "TimeTimerWidget" AS ENUM ('SHOWN', 'HIDDEN_UNTIL_START', 'OFF');

-- CreateTable
CREATE TABLE "time_timer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "activity" "TimeActivity" NOT NULL,
    "storyId" TEXT,
    "storyIdentifier" TEXT,
    "storyTitle" TEXT,
    "description" TEXT,
    "billable" BOOLEAN,
    "timezone" TEXT NOT NULL,
    "status" "TimeTimerStatus" NOT NULL DEFAULT 'RUNNING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_timer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_timer_segment" (
    "id" TEXT NOT NULL,
    "timerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "stopAt" TIMESTAMPTZ(3),

    CONSTRAINT "time_timer_segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_timer_stop" (
    "timerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "outcome" "TimeTimerStopOutcome" NOT NULL,
    "entryIds" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_timer_stop_pkey" PRIMARY KEY ("timerId")
);

-- CreateTable
CREATE TABLE "time_tracking_preference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timerWidget" "TimeTimerWidget" NOT NULL DEFAULT 'SHOWN',
    "timerReminders" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_tracking_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "time_timer_organizationId_userId_key" ON "time_timer"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "time_timer_userId_idx" ON "time_timer"("userId");

-- CreateIndex
CREATE INDEX "time_timer_projectId_idx" ON "time_timer"("projectId");

-- CreateIndex
CREATE INDEX "time_timer_storyId_idx" ON "time_timer"("storyId");

-- CreateIndex
CREATE INDEX "time_timer_segment_timerId_startAt_idx" ON "time_timer_segment"("timerId", "startAt");

-- CreateIndex
CREATE INDEX "time_timer_stop_userId_createdAt_idx" ON "time_timer_stop"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "time_timer_stop_organizationId_idx" ON "time_timer_stop"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "time_tracking_preference_organizationId_userId_key" ON "time_tracking_preference"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "time_tracking_preference_userId_idx" ON "time_tracking_preference"("userId");

-- AddForeignKey
ALTER TABLE "time_timer" ADD CONSTRAINT "time_timer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_timer" ADD CONSTRAINT "time_timer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_timer" ADD CONSTRAINT "time_timer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_timer" ADD CONSTRAINT "time_timer_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_timer_segment" ADD CONSTRAINT "time_timer_segment_timerId_fkey" FOREIGN KEY ("timerId") REFERENCES "time_timer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_timer_stop" ADD CONSTRAINT "time_timer_stop_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_timer_stop" ADD CONSTRAINT "time_timer_stop_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_tracking_preference" ADD CONSTRAINT "time_tracking_preference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_tracking_preference" ADD CONSTRAINT "time_tracking_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- What Prisma cannot express.
-- ---------------------------------------------------------------------------

-- At most ONE open segment per timer: pause closes it, resume opens the next.
-- The timer's version check is what serializes changes; this index is the
-- backstop.
CREATE UNIQUE INDEX "time_timer_segment_open"
    ON "time_timer_segment" ("timerId")
    WHERE "stopAt" IS NULL;

-- A segment never stops before it starts.
ALTER TABLE "time_timer_segment"
    ADD CONSTRAINT "time_timer_segment_stop_after_start"
    CHECK ("stopAt" IS NULL OR "stopAt" >= "startAt");
