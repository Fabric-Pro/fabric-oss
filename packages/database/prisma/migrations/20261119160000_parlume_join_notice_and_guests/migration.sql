-- Parlume join notice and meetings with external guests.
--
-- When the bot is admitted it posts a notice in the meeting chat, or says it
-- aloud when the chat is out of reach. The session records when the notice
-- reached the meeting and the tag of its post.
--
-- An organization chooses what Parlume does while an external guest is in a
-- meeting: keep notes and stay quiet (the default), or leave, because it keeps
-- Parlume to internal meetings. An automatic join whose calendar invitation
-- names someone outside the organization counts as a meeting with a guest
-- from the start; the session also records when a guest was first seen.
--
-- The auto-join switch records when it was turned on, beside who did.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The columns are on `organization_parlume_settings`,
-- `parlume_meeting_session` and `project_linked_meeting`, which keep their
-- policies (scripts/apply-rls-direct.ts).

-- CreateEnum
CREATE TYPE "parlume_guest_policy" AS ENUM ('NOTES_ONLY', 'INTERNAL_ONLY');

-- AlterTable
ALTER TABLE "organization_parlume_settings"
  ADD COLUMN "guestPolicy" "parlume_guest_policy" NOT NULL DEFAULT 'NOTES_ONLY';

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "joinNoticeAt" TIMESTAMP(3),
  ADD COLUMN "joinNoticeTag" TEXT,
  ADD COLUMN "externalInvitees" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "guestJoinedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "project_linked_meeting"
  ADD COLUMN "parlumeAutoJoinEnabledAt" TIMESTAMP(3);
