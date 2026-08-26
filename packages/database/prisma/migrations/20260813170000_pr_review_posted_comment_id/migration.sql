-- The GitHub comment a review was posted as.
--
-- Nullable: reviews that predate this were posted (if at all) before the id was
-- recorded, and the first run after this migration falls back to searching the
-- pull request's comments for the marker, then stores what it finds.
ALTER TABLE "pull_request_review" ADD COLUMN "postedCommentId" BIGINT;
