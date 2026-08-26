-- Per-project log source for bug-analysis context (Fizzy #1234).
--
-- Deliberately generic: `logSourceProvider` is a provider id from the registry
-- and `logSourceConfig` is that provider's own settings, so adding a new log
-- platform never needs another migration. Neither column holds a credential —
-- providers authenticate with the worker's own identity or an existing MCP
-- config. NULL means the project inherits the deployment's configuration,
-- which is what every project does today.
--
-- Hand-written rather than generated. `prisma migrate dev` produced a diff
-- carrying pre-existing drift between the migration history and schema.prisma
-- (index renames on pull_request_review / qa_sign_off / coding_run, a
-- duplicate mcp_server index, and dropped defaults on project_qa_settings and
-- test_case_work_item_link). That drift is unrelated to this change and must
-- not ride along with it.
ALTER TABLE "project"
  ADD COLUMN "logSourceProvider" TEXT,
  ADD COLUMN "logSourceConfig" JSONB;
