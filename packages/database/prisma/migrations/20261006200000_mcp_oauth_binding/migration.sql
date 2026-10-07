-- Pin each MCP config's OAuth credentials to the authorization server that
-- issued them (`oauthBinding`), fence every credential write with a grant
-- generation (`oauthGrantGeneration`), and carry the start of an OAuth flow's
-- resolved authorization server and generation to its callback. Additive
-- only: the previous app version neither reads nor writes these columns.
-- The data backfill is the next migration.

-- AlterTable
ALTER TABLE "mcp_config" ADD COLUMN     "oauthBinding" JSONB,
ADD COLUMN     "oauthGrantGeneration" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "mcp_oauth_state" ADD COLUMN     "authorizationServerSnapshot" JSONB,
ADD COLUMN     "expectedGrantGeneration" INTEGER;
