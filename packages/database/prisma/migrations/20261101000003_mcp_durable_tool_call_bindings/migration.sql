-- DropIndex
-- migration-lint: allow blocking-index — The table was introduced by the immediately preceding, not-shared migration and can contain only a few local development receipts.
-- migration-lint: allow destructive-without-marker — This replaces the preceding migration's internal uniqueness constraint before either migration reaches a shared environment; no application code reads the index by name.
DROP INDEX "mcp_durable_tool_call_organizationId_userId_toolName_idempo_key";

-- AlterTable
ALTER TABLE "mcp_durable_tool_call" ADD COLUMN     "credentialId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "credentialKind" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "projectBinding" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "serverBinding" TEXT NOT NULL DEFAULT '';

-- CreateIndex
-- migration-lint: allow blocking-index — The table was introduced by the immediately preceding, not-shared migration and can contain only a few local development receipts.
CREATE UNIQUE INDEX "mcp_durable_tool_call_replay_key" ON "mcp_durable_tool_call"("organizationId", "userId", "credentialKind", "credentialId", "projectBinding", "serverBinding", "toolName", "idempotencyKey");
