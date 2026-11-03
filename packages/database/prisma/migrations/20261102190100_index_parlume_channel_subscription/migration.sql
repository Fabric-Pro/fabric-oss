-- Keep the session table writable while binding subscription identities.
CREATE UNIQUE INDEX CONCURRENTLY "parlume_meeting_session_channelSubscriptionId_key" ON "parlume_meeting_session"("channelSubscriptionId");
