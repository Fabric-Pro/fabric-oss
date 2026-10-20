-- Drops the legacy organization-level Firecrawl columns. Search provider rows
-- replaced them. Fizzy #3078 removed every read and write, and v1.16.24 marked
-- the fields @ignore so Prisma Client stopped selecting them. Production runs
-- v1.16.24 or later, so no running app version reads these columns.
--
-- Rollback: forward-only. Rolling production back below v1.16.24 after this
-- lands would select columns that no longer exist; re-add them nullable first.
--
-- The User.firecrawl* columns are still read and are not touched here.
--
-- migration-lint: allow destructive-without-marker — contract step; v1.16.24, which stopped selecting these columns, is live in production and nothing reads them

ALTER TABLE "organization" DROP COLUMN "firecrawlApiKey",
DROP COLUMN "firecrawlEnabled",
DROP COLUMN "firecrawlConfiguredAt",
DROP COLUMN "firecrawlLastUsedAt";
