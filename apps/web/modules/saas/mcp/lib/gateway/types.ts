/**
 * Fabric MCP Gateway - Types
 *
 * Type definitions for the unified MCP gateway that aggregates
 * platform tools and user-connected MCP servers.
 */

export interface GatewaySession {
	sessionId: string;
	userId: string;
	organizationId: string | null;
	userName: string;
	email: string;
	role: "user" | "admin";
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
