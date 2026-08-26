/**
 * MCP Registry Types
 *
 * Shared types for account-based MCP providers.
 */

/**
 * Credential authentication type
 */
export type CredentialAuthType = "oauth" | "api_key" | "none";

/**
 * URL pattern for link enrichment
 */
export interface MCPUrlPattern {
	/** Pattern to match (e.g., "https://mail.google.com/*") */
	pattern: string;
	/** Tool to invoke for this URL */
	tool?: string;
	/** Description of what this pattern handles */
	description?: string;
}

/**
 * Tool schema for MCP
 */
export interface MCPToolSchema {
	/** Tool name */
	name: string;
	/** Tool description */
	description?: string;
	/** JSON Schema for input parameters */
	inputSchema: Record<string, unknown>;
	/** Fields requiring user approval before execution */
	approvalRequiredFields?: string[];
}

/**
 * Capabilities for an MCP (simplified tool listing)
 */
export type MCPCapability = string;

/**
 * MCP definition for an account-based service
 */
export interface MCPDefinition {
	/** Unique identifier (e.g., "gmail") */
	id: string;
	/** Display name (e.g., "Gmail") */
	name: string;
	/** Server name for identifiers */
	serverName: string;
	/** Optional label override for display */
	label?: string;
	/** Description of capabilities */
	description: string;
	/** Icon URL or emoji */
	icon?: string;
	/** URL patterns this MCP can handle */
	urlPatterns?: MCPUrlPattern[];
	/** Pre-defined tools (for UI display before connection) */
	tools?: MCPToolSchema[];
	/** Simplified capability list */
	capabilities?: MCPCapability[];
	/** Guidance for AI workflows */
	workflowGuidance?: string;
	/** Required scopes for OAuth */
	requiredScopes?: string[];
	/** Whether this MCP is currently available */
	available?: boolean;
	/** Coming soon flag */
	comingSoon?: boolean;
}

/**
 * Account definition for a service provider
 */
export interface AccountDefinition {
	/** Unique identifier (e.g., "google") */
	id: string;
	/** Display name (e.g., "Google") */
	name: string;
	/** Version for tracking tool definition changes (e.g., "1.0.0") */
	version?: string;
	/** Credential type key (e.g., "google_oauth") */
	credentialType: string;
	/** Authentication type */
	authType: CredentialAuthType;
	/** Icon URL or identifier */
	icon?: string;
	/** MCPs available for this account */
	mcps: MCPDefinition[];
	/** OAuth scopes required at account level */
	baseScopes?: string[];
	/** Whether this account's MCPs are always enabled (no auth required) */
	alwaysEnabled?: boolean;
	/** Environment binding keys required (e.g., ['SANDBOX']) */
	envBindingKeys?: string[];
	/** Additional credential keys needed from user config */
	additionalCredentialKeys?: string[];
}
