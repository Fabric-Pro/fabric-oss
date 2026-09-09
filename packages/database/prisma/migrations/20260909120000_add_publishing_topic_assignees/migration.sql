-- AlterTable
-- Assignees on a publishing topic (Fizzy #1851, A8): who should PICK THIS UP,
-- kept separate from the contributor columns added in
-- 20260907150000_add_publishing_topic_contributor_override, which record whose
-- work the topic derives from. Overloading those would have made attribution
-- and routing the same field.
--
-- No backfill and no CONCURRENTLY index: a NOT NULL array column with a
-- constant default is filled by the DEFAULT for every existing row, and nothing
-- queries topics BY assignee — the column is read as part of the topic row the
-- Inbox already loads.
ALTER TABLE "publishing_topic"
  ADD COLUMN "assigneeUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
