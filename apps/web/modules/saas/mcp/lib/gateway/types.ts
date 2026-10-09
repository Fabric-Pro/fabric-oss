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
	/**
	 * A coding agent signed in over OAuth. Like an organization key its tenant
	 * is fixed (at consent time) and may not be steered by a request header.
	 */
	| "oauth"
	/** Browser cookie. Carries the user's full interactive authority. */
	| "session";

export interface GatewaySession {
	sessionId: string;
	userId: string;
	organizationId: string | null;
	/**
	 * The one project this session reaches, when it was opened from a project's
	 * URL; absent or null for an organization-wide session. A bound session's
	 * organization is the one hosting the project, and `./project-binding` is
	 * what keeps every tool call on it.
	 */
	projectId?: string | null;
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

/** The MCP tool annotations the gateway reads. A server's own claims, not Fabric's. */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
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
	annotations?: ToolAnnotations;
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
		annotations?: ToolAnnotations;
	}>;
}

/**
 * Credentials whose tenant is fixed when they are issued, so a request may not
 * move them to another organization — an organization key at creation, an OAuth
 * token at consent. Every "may this reach that organization" decision asks this
 * rather than comparing against one credential kind.
 */
export function isOrganizationBoundCredential(
	credential: GatewayCredential,
): boolean {
	return credential === "organization-key" || credential === "oauth";
}

/**
 * Credentials that act for a person without being that person at a keyboard —
 * a coding agent signed in over OAuth, or an organization key. What they may do
 * is whatever the person consented to or the key's creator chose, so they are
 * held to declared facts (a server's own `readOnlyHint`, the granted scopes)
 * and never to a guess made from a tool's name.
 */
export function isDelegatedCredential(credential: GatewayCredential): boolean {
	return credential === "organization-key" || credential === "oauth";
}
