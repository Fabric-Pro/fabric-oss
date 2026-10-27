-- Separate from ADD COLUMN/CONSTRAINT so validation does not retain its
-- ACCESS EXCLUSIVE lock while scanning the existing series and sessions.
ALTER TABLE "project_linked_meeting" VALIDATE CONSTRAINT "project_linked_meeting_parlumeAutoJoinUserId_fkey";
ALTER TABLE "parlume_meeting_session" VALIDATE CONSTRAINT "parlume_meeting_session_linkedMeetingId_fkey";
