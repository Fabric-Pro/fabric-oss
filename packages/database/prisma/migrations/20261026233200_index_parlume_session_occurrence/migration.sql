-- Run outside a transaction: Parlume sessions remain writable during the index build.
-- One session per auto-joined occurrence; manual sessions leave both columns NULL.
CREATE UNIQUE INDEX CONCURRENTLY "parlume_meeting_session_linkedMeetingId_occurrenceStart_key" ON "parlume_meeting_session"("linkedMeetingId", "occurrenceStart");
