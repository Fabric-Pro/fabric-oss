-- Run outside a transaction: linked meetings remain writable during the index build.
CREATE INDEX CONCURRENTLY "project_linked_meeting_parlumeAutoJoinUserId_idx" ON "project_linked_meeting"("parlumeAutoJoinUserId");
