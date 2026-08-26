-- Add accessTokenHash to mcp_config for O(1), timing-stable bearer lookup
-- in the GitLab MCP shim (replaces the prior linear scan + plaintext compare).
--
-- The hash is HMAC-SHA-256(token, BETTER_AUTH_SECRET) — useless without the
-- secret, so DB read access alone cannot brute-force matches. Backfilled
-- by `pnpm --filter @repo/database tsx scripts/backfill-mcp-token-hash.ts`.

ALTER TABLE "mcp_config"
  ADD COLUMN "accessTokenHash" TEXT;

CREATE UNIQUE INDEX "mcp_config_accessTokenHash_key"
  ON "mcp_config"("accessTokenHash");
