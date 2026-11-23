-- Parlume marks each speaker in a meeting as a member, a guest or unknown.
--
-- `parlume_meeting_session."memberSpeakerIds"` and `"guestSpeakerIds"`: the
-- Teams ids of the participants Fabric checked when they joined, by the
-- outcome it relayed to the bridge: a member it confirmed as able to read
-- the project, or a guest it could not confirm. The saved transcript and the
-- Parlume page mark a speaker by them; a speaker in neither is unknown. They
-- are cleared when the meeting's segments are deleted.
--
-- Existing rows: both default to empty, so every speaker of a meeting held
-- before this change is unknown, except one Teams itself labels a guest. No
-- backfill.
--
-- Rolling deploy: the previous app version neither reads nor writes the
-- columns, and both have a default, so both versions run against this schema.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The columns are on `parlume_meeting_session`, which
-- keeps its policy (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "memberSpeakerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "guestSpeakerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
