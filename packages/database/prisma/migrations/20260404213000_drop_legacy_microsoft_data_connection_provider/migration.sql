BEGIN;

UPDATE "data_connection"
SET "provider" = 'MICROSOFT_365'
WHERE "provider" = 'MICROSOFT';

UPDATE "data_connection_credential"
SET "provider" = 'MICROSOFT_365'
WHERE "provider" = 'MICROSOFT';

ALTER TYPE "DataConnectionProvider" RENAME TO "DataConnectionProvider_old";

CREATE TYPE "DataConnectionProvider" AS ENUM (
  'GOOGLE_DRIVE',
  'S3',
  'GOOGLE_STORAGE',
  'R2',
  'DROPBOX',
  'AIRTABLE',
  'CODA',
  'GITBOOK',
  'NOTION',
  'CONFLUENCE',
  'TEAMS',
  'INTERCOM',
  'GITHUB',
  'GITLAB',
  'BITBUCKET',
  'LINEAR',
  'ASANA',
  'CLICKUP',
  'SLACK',
  'SNOWFLAKE',
  'BIGQUERY',
  'ZENDESK',
  'GONG',
  'GMAIL',
  'JIRA',
  'MICROSOFT_365',
  'SALESFORCE',
  'HUBSPOT'
);

ALTER TABLE "data_connection"
ALTER COLUMN "provider" TYPE "DataConnectionProvider"
USING ("provider"::text::"DataConnectionProvider");

ALTER TABLE "data_connection_credential"
ALTER COLUMN "provider" TYPE "DataConnectionProvider"
USING ("provider"::text::"DataConnectionProvider");

DROP TYPE "DataConnectionProvider_old";

COMMIT;
