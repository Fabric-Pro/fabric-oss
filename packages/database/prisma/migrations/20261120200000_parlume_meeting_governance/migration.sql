-- Parlume answers with the asker's access and keeps confidential discussion to
-- the people who were in the meeting.
--
-- `parlume_meeting_session."attendeeUserIds"`: the Fabric accounts Fabric
-- confirmed in the meeting as able to read the project, each once. With the
-- project's managers they are the only readers of the meeting's confidential
-- discussion and what was made from it.
--
-- `parlume_meeting_session."confidential"`, `"confidentialSince"` and
-- `"confidentialBy"`: part or all of the meeting is confidential; while
-- `confidentialSince` is set, new segments are stored confidential.
--
-- `parlume_meeting_segment."confidential"`: the segment was said or typed
-- while the meeting was confidential.
--
-- `parlume_meeting_turn."requesterUserId"`: the confirmed participant who
-- asked; the turn's lookups run with that account's project access.
--
-- Existing rows: every column defaults to "not confidential" and "no
-- verified attendee recorded". Meetings held before this change stay as they
-- are, and the rules apply to meetings from now on. No backfill.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The columns are on tables that keep their policies
-- (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "attendeeUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "confidential" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "confidentialSince" TIMESTAMP(3),
  ADD COLUMN "confidentialBy" TEXT;

-- AlterTable
ALTER TABLE "parlume_meeting_segment"
  ADD COLUMN "confidential" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "parlume_meeting_turn"
  ADD COLUMN "requesterUserId" TEXT;
