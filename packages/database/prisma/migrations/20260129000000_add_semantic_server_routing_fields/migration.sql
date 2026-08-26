-- AddColumn: Semantic server routing metadata (Phase 0 + Phase 1)
ALTER TABLE "mcp_config" ADD COLUMN "description" TEXT;
ALTER TABLE "mcp_config" ADD COLUMN "domainKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "mcp_config" ADD COLUMN "exampleQueries" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "mcp_config" ADD COLUMN "embedding" BYTEA;
ALTER TABLE "mcp_config" ADD COLUMN "embeddingGeneratedAt" TIMESTAMP(3);
