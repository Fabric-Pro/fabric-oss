-- Add the Newsletter Blurb content type (Fizzy #1988, Phase 2D slice 2).
--
-- ONE STATEMENT, DELIBERATELY. `ALTER TYPE ... ADD VALUE` may run inside a
-- transaction block on PostgreSQL 12+, but the new value cannot be USED until
-- that transaction commits. So no default, no backfill and no partial-index
-- predicate naming 'NEWSLETTER_BLURB' may join this file — they would fail at
-- apply time with "unsafe use of new value of enum type". The migration linter
-- has no rule for this; it is an engine constraint.
ALTER TYPE "PublishingTopicPostType" ADD VALUE IF NOT EXISTS 'NEWSLETTER_BLURB';
