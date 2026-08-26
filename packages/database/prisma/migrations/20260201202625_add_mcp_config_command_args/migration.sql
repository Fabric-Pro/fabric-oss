-- AlterTable
ALTER TABLE "mcp_config" ADD COLUMN "commandArgs" TEXT[] DEFAULT ARRAY[]::TEXT[];
