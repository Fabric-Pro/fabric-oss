-- DropColumn: Remove embedding columns (embeddings moved to Qdrant for optimal vector search)
ALTER TABLE "mcp_config" DROP COLUMN IF EXISTS "embedding";
ALTER TABLE "mcp_config" DROP COLUMN IF EXISTS "embeddingGeneratedAt";
