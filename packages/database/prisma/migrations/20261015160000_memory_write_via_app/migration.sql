-- A memory write that came in through the API itself (an oRPC call), beside the MCP tool and the CLI (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "ProjectMemoryWriteVia" ADD VALUE IF NOT EXISTS 'APP';
