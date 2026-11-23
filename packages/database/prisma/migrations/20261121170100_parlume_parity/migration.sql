-- Parlume parity with meeting assistants that keep an internal page beside
-- the call.
--
-- `organization_parlume_settings."teamsLoginGroup"`: the Teams login group on
-- the organization's own Attendee project that its bot signs in with, sent as
-- `teams_settings.login_group_name`. Null keeps Attendee's default, the
-- project's oldest group.
--
-- `organization_parlume_settings."channelIntegrationId"`: the
-- organization-shared Microsoft connection Parlume replies in a Teams channel
-- meeting with, before the inviter's own. Not a foreign key: every use checks
-- again that the connection is active, shared and in the organization, and a
-- removed one is skipped.
--
-- `parlume_suggestion."dismissedAt"` and `"dismissedById"`: a member
-- dismissed the suggestion on the Parlume page.
--
-- `parlume_meeting_session."notesNotifiedAt"`: when the meeting's internal
-- invitees were told its notes are ready. Claimed once.
--
-- Existing rows: every column is null. No backfill: meetings whose notes are
-- already written are not announced again.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The columns are on tables that keep their policies
-- (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "organization_parlume_settings"
  ADD COLUMN "teamsLoginGroup" TEXT,
  ADD COLUMN "channelIntegrationId" TEXT;

-- AlterTable
ALTER TABLE "parlume_suggestion"
  ADD COLUMN "dismissedAt" TIMESTAMP(3),
  ADD COLUMN "dismissedById" TEXT;

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "notesNotifiedAt" TIMESTAMP(3);
