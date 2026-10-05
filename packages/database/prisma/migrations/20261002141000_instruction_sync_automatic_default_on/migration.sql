-- Automatic sync is on for a new coding-instructions repository sync (Fizzy
-- #2878): the developer's checkout follows the branch tip, so Fabric's copy
-- has to follow it too or the two drift apart until someone clicks Sync.
--
-- Only the column default changes. NO backfill: a row that stored false may
-- be a deliberate choice, and rewriting it would turn syncing on for a
-- project that turned it off. Metadata-only, takes no table rewrite, and the
-- previous app version, which writes the column explicitly, is unaffected.
ALTER TABLE "project_instruction_repository_sync" ALTER COLUMN "automatic" SET DEFAULT true;
