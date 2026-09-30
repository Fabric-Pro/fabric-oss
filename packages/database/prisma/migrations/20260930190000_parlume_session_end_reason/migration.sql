-- CreateEnum
CREATE TYPE "parlume_meeting_end_reason" AS ENUM ('STOPPED', 'REMOVED', 'IDLE', 'ACCESS_REVOKED', 'STREAM_ERROR', 'MAX_DURATION', 'PROVIDER_FAILED', 'START_FAILED');

-- AlterTable
ALTER TABLE "parlume_meeting_session" ADD COLUMN     "endReason" "parlume_meeting_end_reason";
