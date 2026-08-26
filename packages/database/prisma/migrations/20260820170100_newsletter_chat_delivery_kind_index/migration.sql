-- Widen the ledger's dedup key with "kind" (Fizzy #2203). Without it an approval
-- alert and a content delivery to the same channel for the same send collide on
-- the old key and the alert is silently refused as a duplicate claim.
--
-- CONCURRENTLY, because newsletter_chat_delivery is populated and an ordinary
-- build holds a write lock for its whole duration. This statement is ALONE in
-- this file on purpose: Prisma does not wrap a single-statement migration in a
-- transaction, which is what lets CONCURRENTLY run at all. Adding a second
-- statement here fails with SQLSTATE 25001.
--
-- Deliberately NOT "IF NOT EXISTS": a failed concurrent build leaves the index
-- with indisvalid = false, and a retry with IF NOT EXISTS sees the name taken
-- and silently skips it — leaving an invalid index that serves no queries while
-- the migration records as applied (docs/database-promotion.md:292-299).
CREATE UNIQUE INDEX CONCURRENTLY
  "newsletter_chat_delivery_send_kind_channel_key"
  ON "newsletter_chat_delivery" ("sendId", "kind", "platform", "externalTeamId", "channelId");
