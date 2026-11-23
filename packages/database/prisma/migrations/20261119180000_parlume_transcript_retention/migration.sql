-- Parlume transcript deletion and retention.
--
-- A member who invited Parlume, or a project manager, can delete a finished
-- session's meeting content. An hourly sweep deletes the raw transcript 90
-- days after the meeting. Either way the session row and its notes stay, and
-- the session records when its transcript was deleted.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The column is on `parlume_meeting_session`, which keeps
-- its policy (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "transcriptDeletedAt" TIMESTAMP(3);
