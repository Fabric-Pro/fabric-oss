-- CreateEnum
CREATE TYPE "McpDurableToolCallStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "mcp_durable_tool_call" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "status" "McpDurableToolCallStatus" NOT NULL DEFAULT 'RUNNING',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_durable_tool_call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_durable_tool_call_expiresAt_id_idx" ON "mcp_durable_tool_call"("expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_durable_tool_call_organizationId_userId_toolName_idempo_key" ON "mcp_durable_tool_call"("organizationId", "userId", "toolName", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "mcp_durable_tool_call" ADD CONSTRAINT "mcp_durable_tool_call_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_durable_tool_call" ADD CONSTRAINT "mcp_durable_tool_call_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
