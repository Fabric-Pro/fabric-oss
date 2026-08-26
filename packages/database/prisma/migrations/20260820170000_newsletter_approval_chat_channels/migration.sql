-- lock_timeout FIRST. Both ALTERs below take ACCESS EXCLUSIVE; without a bound
-- an incompatible open transaction makes this wait at server defaults and every
-- application write queues behind it. The promotion preflight sets a timeout on
-- its OWN connection, which does not protect `migrate deploy`
-- (docs/database-promotion.md:54-62), so the migration sets its own.
--
-- This migration has several statements, so Prisma wraps it in a transaction
-- and SET LOCAL applies. Never add a statement to the companion
-- CREATE INDEX CONCURRENTLY migration: a second statement there would
-- transactionalise it and the concurrent build would fail with SQLSTATE 25001.
SET LOCAL lock_timeout = '5s';

-- Fizzy #2203: per-project chat targets for the release-notes review alert.
ALTER TABLE "newsletter_settings" ADD COLUMN "approvalChatChannels" JSONB;

-- Discriminate the review alert from the published-notes delivery in the
-- existing exactly-once ledger. The DEFAULT backfills every existing row
-- correctly: content delivery is the only thing that has ever written here.
-- Nullable-with-default keeps the previous app version working, which does not
-- write this column.
ALTER TABLE "newsletter_chat_delivery" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'CONTENT';
