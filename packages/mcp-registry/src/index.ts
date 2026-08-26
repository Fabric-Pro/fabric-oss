/**
 * MCP Registry Package
 *
 * Shared types, constants, and utilities for account-based MCP providers.
 * Used by @repo/temporal and @repo/api to avoid circular dependencies.
 */

// Always-Enabled MCPs (no auth required)
export {
	ALWAYS_ENABLED_ACCOUNTS,
	getAlwaysEnabledAccounts,
	getAlwaysEnabledMcps,
	getAlwaysEnabledWorkflowGuidance,
	SANDBOX_ACCOUNT,
} from "./always-enabled";
// Conditionally-Enabled MCPs (require OAuth)
export {
	CONDITIONAL_ACCOUNTS,
	GITHUB_ACCOUNT,
	GITLAB_ACCOUNT,
	getConditionalAccount,
	MICROSOFT_TEAMS_ACCOUNT,
} from "./conditional-accounts";
// Types
export type {
	AccountDefinition,
	CredentialAuthType,
	MCPCapability,
	MCPDefinition,
	MCPToolSchema,
	MCPUrlPattern,
} from "./types";
// Workflow Guidance Constants
export {
	CREDENTIAL_TYPE_GUIDANCE,
	GITHUB_WORKFLOW_GUIDANCE,
	GMAIL_WORKFLOW_GUIDANCE,
	GOOGLE_DOCS_WORKFLOW_GUIDANCE,
	GOOGLE_SHEETS_WORKFLOW_GUIDANCE,
	GUIDANCE_BY_SERVER_NAME,
	getGuidanceByCredentialType,
	getGuidanceByServerName,
	MICROSOFT_TEAMS_WORKFLOW_GUIDANCE,
	SANDBOX_WORKFLOW_GUIDANCE,
} from "./workflow-guidance";
