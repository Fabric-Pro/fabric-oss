-- AlterTable: store the full Atlassian Cloud accessible-resources list so the
-- PM-sync upload path can route each Jira issue to its OWN site (multi-site
-- accounts push issues to different sites; the single primary
-- atlassianCloudSiteUrl/CloudId is insufficient).
ALTER TABLE "mcp_config"
  ADD COLUMN "atlassianCloudAccessibleResources" JSONB;
