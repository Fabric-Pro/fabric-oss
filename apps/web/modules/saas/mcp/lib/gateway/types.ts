/**
 * Fabric MCP Gateway - Types
 *
 * Type definitions for the unified MCP gateway that aggregates
 * platform tools and user-connected MCP servers.
 */

/**
 * What proved the caller's identity for this session.
 *
 * The gateway used to forget this the moment authentication finished, which
 * made an API-key request indistinguishable from a browser one. Two things
 * depend on telling them apart: an organization key is bound to the tenant it
 * was issued for and may not be steered out of it, and the scopes chosen when a
 * key was created only mean something if the surface consuming them knows a key
 * was involved.
 */
export type GatewayCredential =
	/** `org_` key — tenant fixed by the key record. */
	| "organization-key"
	/** `fab_` key — tenant resolved per request from the owner's memberships. */
	| "personal-key"
	/** Browser cookie. Carries the user's full interactive authority. */
	| "session";

export interface GatewaySession {
	sessionId: string;
	userId: string;
	organizationId: string | null;
	userName: string;
	email: string;
	role: "user" | "admin";
	/** How this session authenticated. See `GatewayCredential`. */
	credential: GatewayCredential;
	/**
	 * Scopes granted by the API key that opened this session.
	 *
	 * A browser session carries `["*"]`: there is no key to have chosen scopes,
	 * and the interactive permission checks that already govern the UI are not
	 * loosened by anything here.
	 */
	scopes: string[];
	createdAt: Date;
	expiresAt: Date;
}

export interface GatewayToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** Source: "platform" for Fabric tools, or MCPConfig displayName for connected servers */
	_gateway_source?: string;
	/** MCPConfig ID if this tool comes from a connected server */
	_gateway_config_id?: string;
	/** MCP tool annotations */
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}

export interface ToolCallResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	structuredContent?: unknown;
}

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

/**
 * Connected MCP server info for tool aggregation
 */
export interface ConnectedServerInfo {
	configId: string;
	displayName: string;
	toolPrefix: string;
	tools: Array<{
		name: string;
		description?: string;
		inputSchema?: Record<string, unknown>;
	}>;
}
