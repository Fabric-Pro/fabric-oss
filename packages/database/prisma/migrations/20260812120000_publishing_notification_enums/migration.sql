-- Publishing Suite 1C-2b: the notification type and category for contributor notifications.
--
-- ALTER TYPE ... ADD VALUE is a ONE-WAY DOOR: it does not roll back, and rolling back a release
-- does not restore the schema. Accepted deliberately (the repo has done it many times) and
-- recorded here so it reads as a decision rather than a discovery. This is also why the ledger's
-- `channel` and `status` are TEXT with CHECK constraints instead of enums — 1C-2c and 1C-2d widen
-- both, and 1C-3 adds a chat channel.
--
-- Safe in a transaction-wrapped migration on PostgreSQL 12+: the new value simply cannot be USED
-- until the transaction commits, and nothing here uses it.
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'PUBLISHING';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PUBLISHING_TOPICS_READY';
