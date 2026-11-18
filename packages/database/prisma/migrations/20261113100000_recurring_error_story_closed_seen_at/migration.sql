-- Record the first scan observation that a linked bug is no longer open.
ALTER TABLE "recurring_error_signature" ADD COLUMN "storyClosedSeenAt" TIMESTAMP(3);
