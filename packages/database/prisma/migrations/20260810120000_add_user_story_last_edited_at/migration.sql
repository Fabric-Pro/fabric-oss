-- UserStory.updatedAt is an operational row-write clock and can advance for
-- derived summary/hash writes. Keep semantic edit history separate and leave
-- existing rows unknown rather than manufacturing a backfill from updatedAt.
ALTER TABLE "user_story" ADD COLUMN "lastEditedAt" TIMESTAMP(3);
