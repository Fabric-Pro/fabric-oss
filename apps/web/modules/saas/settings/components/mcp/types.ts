/**
 * MCP Settings Types
 *
 * Shared types for MCP server and configuration management.
 */

// Auth type options
export type AuthType = "NONE" | "API_KEY" | "OAUTH2";

// API Key authentication method
export type ApiKeyMethod = "BEARER" | "HEADER" | "PLAIN";

// Transport type options
// Note: STDIO servers require local execution and cannot be configured via the web UI
export type Transport = "SSE" | "HTTP" | "STDIO";

// MCP Server from registry
export interface McpServer {
	id: string;
	key: string;
	name: string | null;
	description: string | null;
	category?: string | null;
	author?: string | null;
	iconUrl?: string | null;
	defaultUrl: string | null;
	/** Command to run for STDIO servers (e.g., "npx -y @modelcontextprotocol/server-github") */
	command: string | null;
	docsUrl: string | null;
	repositoryUrl?: string | null;
	transport: Transport;
	authMethods: AuthType[];
	/** Default API key method for this server (BEARER or HEADER) */
	apiKeyMethod: ApiKeyMethod | null;
	isSystemProvided: boolean;
	dcrRegistrationEndpoint: string | null;
	oauthDiscoveryUrl: string | null;
	/** Server is auto-enabled for every tenant — no manual setup required. */
	defaultEnabled?: boolean;
}

// MCP Configuration
export interface McpConfig {
	id: string;
	mcpServerId: string;
	mcpServer: McpServer | null;
	displayName: string | null;
	baseUrl: string | null;
	transport: Transport | null;
	authType: AuthType;
	/** API key method - BEARER (Authorization header) or HEADER (X-API-Key) */
	apiKeyMethod: ApiKeyMethod | null;
	enabled: boolean;
	status: string | null;
	scopes: string[];
	encryptedApiKey: string | null;
	oauthClientId: string | null;
	encryptedOauthClientSecret: string | null;
	dcrRegistrationEndpoint: string | null;
	dcrClientMetadata: Record<string, unknown> | null;
	dcrRegisteredAt: Date | null;
	/** Row is a system-managed sentinel for a default-enabled server — must not be toggled off, edited, or deleted by users. */
	isManagedDefault?: boolean;
}

// OAuth status for a configuration
export interface OAuthStatus {
	authenticated: boolean;
	tokenExpired: boolean;
	hasRefreshToken: boolean;
	tokenExpiresAt: string | null;
}

// Scope for settings (user vs organization)
export type McpSettingsScope = "user" | "org";

// Form state for config dialog
export interface McpConfigFormState {
	selectedServer: McpServer | null;
	displayName: string;
	baseUrl: string;
	authType: AuthType;
	apiKeyMethod: ApiKeyMethod;
	apiKey: string;
	showApiKey: boolean;
	enabled: boolean;
	oauthClientId: string;
	oauthClientSecret: string;
	showOAuthSecret: boolean;
	scopes: string;
	useDcr: boolean;
	dcrRegisteredAt: string | null;
}

// Form state for custom server dialog
export interface McpServerFormState {
	name: string;
	description: string;
	defaultUrl: string;
	docsUrl: string;
	transport: Transport;
	authType: AuthType;
	/** API key method - BEARER (Authorization header) or HEADER (X-API-Key) */
	apiKeyMethod: ApiKeyMethod;
	autoDiscoverOAuth: boolean;
	discoveryUrl: string;
	dcrRegistrationEndpoint: string;
}

// Dialog open states
export interface McpDialogState {
	configDialogOpen: boolean;
	customServerDialogOpen: boolean;
	deleteConfigDialogOpen: boolean;
	deleteServerDialogOpen: boolean;
}

// Items pending deletion
export interface McpDeleteState {
	configToDelete: McpConfig | null;
	serverToDelete: McpServer | null;
}

// Loading/testing states
export interface McpLoadingState {
	isTesting: boolean;
	// id of the saved configuration currently being tested from the list.
	// Null when no per-row test is in flight. Use for row-level loaders so
	// only the clicked card shows its spinner instead of all of them.
	testingConfigId: string | null;
	isConnecting: boolean;
	isRegisteringDcr: boolean;
	isDiscoveringEndpoints: boolean;
}

// Query keys for react-query
export const mcpQueryKeys = {
	servers: (organizationId?: string) =>
		organizationId ? ["mcp-servers", { organizationId }] : ["mcp-servers"],
	configs: (scope: McpSettingsScope, organizationId?: string) =>
		scope === "org"
			? ["mcp-configs", { scope: "org", organizationId }]
			: ["mcp-configs", { scope: "user" }],
} as const;

// Helper to get auth type label
export function getAuthTypeLabel(authType: AuthType): string {
	switch (authType) {
		case "API_KEY":
			return "API Key";
		case "OAUTH2":
			return "OAuth 2.0";
		default:
			return "None";
	}
}

// Helper to get default auth type from server
export function getDefaultAuthTypeFromServer(
	server: McpServer | null,
): AuthType {
	if (!server || !Array.isArray(server.authMethods)) {
		return "NONE";
	}
	if (server.authMethods.includes("OAUTH2")) {
		return "OAUTH2";
	}
	if (server.authMethods.includes("API_KEY")) {
		return "API_KEY";
	}
	return "NONE";
}

// Helper to generate key from name
export function generateKeyFromName(name: string): string {
	const base = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!base) {
		return "";
	}

	// Random suffix for uniqueness
	const randomSuffix = Math.random().toString(36).slice(2, 8);
	return `${base}-${randomSuffix}`;
}

// Helper to check if API key is placeholder (masked)
export function isApiKeyPlaceholder(apiKey: string): boolean {
	return apiKey.startsWith("••••");
}

// Helper to check if server can be configured via web UI
// STDIO servers are now supported via the MCP STDIO wrapper service if they have a command
export function isServerConfigurableViaWeb(server: McpServer): boolean {
	// STDIO servers require a command definition to be web-configurable
	// (they need a command to run via the STDIO wrapper)
	if (server.transport === "STDIO") {
		return !!server.command;
	}
	// HTTP and SSE servers are always configurable via web
	return true;
}

// Helper to get transport display info
export function getTransportInfo(transport: Transport): {
	label: string;
	description: string;
	isWebConfigurable: boolean;
} {
	switch (transport) {
		case "HTTP":
			return {
				label: "HTTP",
				description: "Remote server accessible via HTTP",
				isWebConfigurable: true,
			};
		case "SSE":
			return {
				label: "SSE",
				description: "Remote server using Server-Sent Events",
				isWebConfigurable: true,
			};
		case "STDIO":
			return {
				label: "STDIO",
				description:
					"Server runs via STDIO protocol, proxied through Fabric's secure wrapper service. Requires a Personal Access Token (PAT).",
				isWebConfigurable: true,
			};
		default:
			return {
				label: transport,
				description: "Unknown transport type",
				isWebConfigurable: false,
			};
	}
}

// Helper to get credential label based on server type
export function getCredentialLabel(server: McpServer): string {
	if (server.transport === "STDIO") {
		// STDIO servers typically use PATs
		if (server.key?.includes("azure-devops")) {
			return "Personal Access Token (PAT)";
		}
		if (server.key?.includes("github")) {
			return "GitHub Token";
		}
		if (server.key?.includes("figma")) {
			return "Figma Personal Access Token";
		}
		return "Access Token";
	}
	return "API Key";
}

// Helper to get credential placeholder based on server type
export function getCredentialPlaceholder(server: McpServer): string {
	if (server.transport === "STDIO") {
		if (server.key?.includes("azure-devops")) {
			return "Enter your Azure DevOps PAT";
		}
		if (server.key?.includes("github")) {
			return "ghp_xxxxxxxxxxxx";
		}
		if (server.key?.includes("figma")) {
			return "figd_xxxxxxxxxxxx";
		}
		return "Enter your access token";
	}
	return "sk-...";
}

// Helper to get credential help text based on server type
export function getCredentialHelpText(server: McpServer): string {
	if (server.transport === "STDIO") {
		if (server.key?.includes("azure-devops")) {
			return "Create a PAT at https://dev.azure.com with Work Items (Read & Write), Code (Read), and Build (Read) permissions.";
		}
		if (server.key?.includes("github")) {
			return "Create a token at https://github.com/settings/tokens with repo and user scopes.";
		}
		if (server.key?.includes("figma")) {
			return "Create a PAT at figma.com > Settings > Personal Access Tokens. Grant access to the files you need.";
		}
		return "Enter the access token for this service.";
	}
	return "Stored encrypted on server.";
}
