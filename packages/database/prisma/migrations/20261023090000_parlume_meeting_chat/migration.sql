-- CreateEnum
CREATE TYPE "parlume_meeting_segment_source" AS ENUM ('SPEECH', 'CHAT');

-- CreateEnum
CREATE TYPE "parlume_meeting_reply_channel" AS ENUM ('VOICE', 'CHAT');

-- AlterTable
ALTER TABLE "parlume_meeting_segment" ADD COLUMN     "source" "parlume_meeting_segment_source" NOT NULL DEFAULT 'SPEECH';

-- AlterTable
ALTER TABLE "parlume_meeting_session" ADD COLUMN     "suggestionsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "parlume_meeting_turn" ADD COLUMN     "replyChannel" "parlume_meeting_reply_channel" NOT NULL DEFAULT 'VOICE';
