-- Each screenshot a reviewer captures, new or again, signs in to the capture
-- environment and drives a browser and a model. A send now counts the
-- captures its reviewers started, so one review cannot start them without
-- bound.
--
-- The column defaults to 0, so existing rows need no backfill and the
-- previous app version keeps working.

-- AlterTable
ALTER TABLE "newsletter_send" ADD COLUMN "captureStarts" INTEGER NOT NULL DEFAULT 0;
