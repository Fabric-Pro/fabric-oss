-- Parlume records the internal invitees of an automatic join's occurrence.
--
-- A meeting's transcript is for the people who were in the meeting. An
-- automatic join reads the occurrence from the calendar of the person who
-- turned auto-join on; the addresses of its invitees from inside the
-- organization are kept on the session, lower-cased, so a project member
-- invited to the meeting can read its transcript. Nothing about an invitee
-- from outside the organization is stored. A manual invitation, and a session
-- from before this column, has none.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The column is on `parlume_meeting_session`, which keeps
-- its policy (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "inviteeEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
