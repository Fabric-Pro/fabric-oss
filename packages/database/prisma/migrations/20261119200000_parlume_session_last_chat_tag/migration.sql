-- Parlume records the highest chat tag Fabric relayed for each session.
--
-- A session invited back to a meeting numbers its posts after the tags that
-- earlier sessions posted there. Those were counted only from the chat
-- messages that showed back from the bot. The notice an ending session posts
-- just before it leaves shows back after the session has ended, so it was
-- never counted, and the next session reused its tag.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The column is on `parlume_meeting_session`, which keeps
-- its policy (scripts/apply-rls-direct.ts).

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "lastChatTag" INTEGER;
