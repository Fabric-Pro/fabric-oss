-- Track the statusId at the time of the most recent successful PM-tool
-- push so sync can compute label deltas (remove the previous status's
-- label, add the new one) instead of replacing the full label set and
-- clobbering user-added labels on the remote tracker.

ALTER TABLE "user_story"
  ADD COLUMN "lastSyncedStatusId" TEXT;
