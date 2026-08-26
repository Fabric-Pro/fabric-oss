-- =============================================================================
-- remove_bitbucket_from_atlassian_mcp_name
-- =============================================================================
-- Drops "Bitbucket" from the Atlassian MCP server registry name and description.
-- Bitbucket tools still ship via the same Rovo MCP server, but the title and
-- description must not advertise Bitbucket until Atlassian ships OAuth for
-- Bitbucket on Rovo. Tags array is intentionally left unchanged — tooling and
-- search keys keep working.
--
-- Idempotent: setting the same values on every re-run produces zero downstream
-- effects.
-- =============================================================================

UPDATE "mcp_server"
SET
  "name"        = 'Atlassian (Jira & Confluence)',
  "description" = 'Connect to Jira for issue tracking and Confluence for documentation via Atlassian''s official Rovo MCP server. One OAuth connection unlocks both.'
WHERE "key" = 'atlassian'
  AND "isSystemProvided" = true;
