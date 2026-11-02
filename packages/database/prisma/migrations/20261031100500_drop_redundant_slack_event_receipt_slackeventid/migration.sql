-- migration-lint: allow destructive-without-marker — The matching unique index retains lookup coverage and uniqueness for both application versions.
DROP INDEX CONCURRENTLY "slack_event_receipt_slackEventId_idx";
