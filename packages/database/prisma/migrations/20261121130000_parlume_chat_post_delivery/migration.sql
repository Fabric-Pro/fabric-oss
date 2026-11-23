-- Parlume records which posts the meeting chat showed.
--
-- Attendee only queues a chat message, so a post counts as delivered once the
-- chat shows it back to the bridge. The bridge reports each post's outcome,
-- and the Parlume page now shows it on the row the post belongs to: "Posted
-- as P7" on a request, suggestion or proposed change, or "Not shown in the
-- chat" when the chat never showed it. A request may make several posts, so
-- its row keeps the tags the chat showed and the tags it did not; a
-- suggestion and a proposal make one post each.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: unchanged. The columns are on `parlume_meeting_turn`,
-- `parlume_suggestion` and `parlume_action`, which keep their policies
-- (scripts/apply-rls-direct.ts).

-- CreateEnum
CREATE TYPE "parlume_chat_delivery" AS ENUM ('SHOWN', 'NOT_SHOWN');

-- AlterTable
ALTER TABLE "parlume_meeting_turn"
  ADD COLUMN "chatTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "chatUnshownTags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "parlume_suggestion"
  ADD COLUMN "chatDelivery" "parlume_chat_delivery";

-- AlterTable
ALTER TABLE "parlume_action"
  ADD COLUMN "chatDelivery" "parlume_chat_delivery";
