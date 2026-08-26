/**
 * Workflow Integration Plugins
 *
 * This file exports all available integration plugins and registry utilities.
 * Import this file to auto-register all plugins.
 */

// Re-export registry functions
export {
	findActionById,
	getActionsByCategory,
	getAllActions,
	getAllIntegrations,
	getCredentialMapping,
	getIntegration,
	getIntegrationTypes,
	getKnowledgeIntegrationTypes,
	getToolIntegrationTypes,
	hasIntegration,
} from "./registry";
// Re-export types
export * from "./types";

// Import plugins to auto-register them
import "./ai-gateway";
import "./asana";
import "./attio";
import "./bitbucket";
import "./blob";
import "./canva";
import "./clickup";
import "./confluence";
import "./databricks-vector-search";
import "./fal";
import "./firecrawl";
import "./freshservice";
import "./front";
import "./github";
import "./gitlab";
import "./google-drive";
import "./hubspot";
import "./intercom";
import "./jira";
import "./linear";
import "./mcp";
import "./microsoft-teams";
import "./nhtsa-vpic";
import "./notion";
import "./perplexity";
import "./resend";
import "./salesforce";
import "./slack";
import "./zendesk";
import "./clerk";
import "./stripe";
import "./superagent";
import "./webflow";
// Re-export individual plugins for direct access
export { linearPlugin } from "./linear";
export { mcpPlugin } from "./mcp";
export { resendPlugin } from "./resend";
export { slackPlugin } from "./slack";
