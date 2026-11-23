-- Parlume records which Attendee project a session's bot was created on.
--
-- A bot runs on the operator's Attendee project or on the organization's own,
-- and Attendee signs its webhooks with that project's secret. The callback
-- verifies a delivery with the secret of the project the bot was created on,
-- so an organization that saves or removes its own key mid-meeting neither
-- breaks nor relaxes verification for a bot that is already running. A
-- session from before this column keeps resolving the organization's current
-- settings.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The column is on `parlume_meeting_session`, which keeps
-- its policy (scripts/apply-rls-direct.ts).

-- CreateEnum
CREATE TYPE "parlume_attendee_source" AS ENUM ('ENVIRONMENT', 'ORGANIZATION');

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "attendeeSource" "parlume_attendee_source";
