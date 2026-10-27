-- Parlume auto-join: a linked meeting series can be set to have Parlume join
-- each of its occurrences at the start time, without anyone inviting it.
--
-- project_linked_meeting gains the per-series switch, who turned it on (their
-- calendar, Microsoft connection and project permissions are what each join
-- uses), the mode and chat-suggestion choices the joins use, and the reason
-- the last automatic join could not happen.
--
-- parlume_meeting_session records whether a person or auto-join started it,
-- and for an automatic join, which series and occurrence. The unique index on
-- (linkedMeetingId, occurrenceStart), built in 20261026233200, guarantees one session per
-- occurrence however often its join is requested. Manual sessions leave both
-- columns NULL, and NULLs never collide in a Postgres unique index.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: both tables keep their existing RLS policies
-- (scripts/apply-rls-direct.ts); the new columns are not tenant columns.
-- parlumeAutoJoinUserId is attribution and an execution identity, and
-- linkedMeetingId points inside the same project.

-- CreateEnum
CREATE TYPE "parlume_session_trigger" AS ENUM ('MANUAL', 'AUTO');

-- AlterTable
ALTER TABLE "project_linked_meeting" ADD COLUMN     "parlumeAutoJoin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parlumeAutoJoinUserId" TEXT,
ADD COLUMN     "parlumeAutoJoinToolsReadOnly" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "parlumeAutoJoinSuggestions" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "parlumeAutoJoinError" TEXT,
ADD COLUMN     "parlumeAutoJoinErrorAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "parlume_meeting_session" ADD COLUMN     "trigger" "parlume_session_trigger" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "linkedMeetingId" TEXT,
ADD COLUMN     "occurrenceStart" TIMESTAMP(3);

-- AddForeignKey (validated in 20261026233030, indexed in 20261026233100 and
-- 20261026233200, so neither table is locked while existing rows are scanned)
ALTER TABLE "project_linked_meeting" ADD CONSTRAINT "project_linked_meeting_parlumeAutoJoinUserId_fkey" FOREIGN KEY ("parlumeAutoJoinUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "parlume_meeting_session" ADD CONSTRAINT "parlume_meeting_session_linkedMeetingId_fkey" FOREIGN KEY ("linkedMeetingId") REFERENCES "project_linked_meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
