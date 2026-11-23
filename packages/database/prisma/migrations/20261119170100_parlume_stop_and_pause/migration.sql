-- Parlume stop and pause.
--
-- Anyone in the meeting can stop Parlume's answer with a stop phrase typed in
-- the chat, and a project member with the Stop speaking button on the Parlume
-- page. A pause stops the answer too. The stopped turn is STOPPED (added in
-- the migration before this one), with how it was stopped and who stopped it,
-- as the meeting chat names them.
--
-- A pause, by voice, in the chat or on the Parlume page, stops Parlume
-- listening until a member resumes it on the page. The session records when
-- it was paused and by whom while it stays paused. Each pause and resume is
-- also a segment of source EVENT, so the transcript shows it.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The columns are on `parlume_meeting_turn` and
-- `parlume_meeting_session`, which keep their policies
-- (scripts/apply-rls-direct.ts).

-- CreateEnum
CREATE TYPE "parlume_stop_cause" AS ENUM ('CHAT', 'PAGE', 'PAUSE');

-- AlterTable
ALTER TABLE "parlume_meeting_turn"
  ADD COLUMN "stopCause" "parlume_stop_cause",
  ADD COLUMN "stoppedBy" TEXT;

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "pausedAt" TIMESTAMP(3),
  ADD COLUMN "pausedBy" TEXT;
