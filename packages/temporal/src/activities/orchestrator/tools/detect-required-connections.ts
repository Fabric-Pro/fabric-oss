/**
 * Detect Required Connections
 *
 * Detects MCP servers that need to be connected before a task can proceed.
 * This implements the "Composio-like" pattern of dynamically discovering
 * which integrations need to be authenticated.
 *
 * The flow:
 * 1. Search for MCP servers in the registry that match the user's query
 * 2. Check which of those servers the user has valid credentials for
 * 3. Return the servers that are missing credentials as "required connections"
 *
 * Key scenarios:
 * - User has a config but it needs re-auth (needsReauth=true)
 * - User has a config but token is expired
 * - User has NO config for a system-provided server that could help
 */

import { db } from "@repo/database";
import type { RequiredConnection } from "../../../workflows/orchestrator/types/routing.types";

// =============================================================================
// Types
// =============================================================================

export interface DetectRequiredConnectionsInput {
	/** User's query/task description */
	query: string;
	/** User ID */
	userId: string;
	/** Organization ID (if in org context) */
	organizationId?: string;
	/** Matched tool server names from semantic search */
	matchedServerNames?: string[];
	/** Confidence threshold for considering a server needed */
	minConfidence?: number;
}

export interface DetectRequiredConnectionsOutput {
	/** Servers that need to be connected */
	requiredConnections: RequiredConnection[];
	/** Whether there are any required connections */
	hasRequiredConnections: boolean;
}

// =============================================================================
// Helper: Check if user has valid credentials for an MCP server
// =============================================================================

interface McpServerWithConfig {
	id: string;
	key: string;
	name: string;
	description: string | null;
	authMethods: string[];
	isSystemProvided: boolean;
	iconUrl: string | null;
	category: string | null;
	config?: {
		id: string;
		authType: string;
		encryptedApiKey: string | null;
		encryptedAccessToken: string | null;
		tokenExpiresAt: Date | null;
		needsReauth: boolean;
	} | null;
}

async function getMcpServersWithConnectionStatus(
	userId: string,
	organizationId: string | undefined,
	serverNames?: string[],
): Promise<McpServerWithConfig[]> {
	// Build the where clause for system-provided servers
	// If serverNames provided, also filter by name matches
	const servers = await db.mCPServer.findMany({
		where:
			serverNames && serverNames.length > 0
				? {
						isSystemProvided: true,
						OR: serverNames.map((name) => ({
							name: {
								contains: name,
								mode: "insensitive" as const,
							},
						})),
					}
				: {
						isSystemProvided: true,
					},
		select: {
			id: true,
			key: true,
			name: true,
			description: true,
			authMethods: true,
			isSystemProvided: true,
			iconUrl: true,
			category: true,
		},
	});

	// For each server, check if user has a valid config
	const serversWithConfig: McpServerWithConfig[] = [];

	for (const server of servers) {
		// Get user's config for this server
		// SECURITY: Per-user isolation - each user has their own configs even within orgs
		const config = await db.mCPConfig.findFirst({
			where: {
				mcpServerId: server.id,
				userId,
				organizationId: organizationId ?? null,
			},
			select: {
				id: true,
				authType: true,
				encryptedApiKey: true,
				encryptedAccessToken: true,
				tokenExpiresAt: true,
				needsReauth: true,
			},
		});

		serversWithConfig.push({
			...server,
			config: config ?? null,
		});
	}

	return serversWithConfig;
}

// =============================================================================
// Helper: Check if a config has valid credentials
// =============================================================================

function hasValidCredentials(
	config: McpServerWithConfig["config"],
	_authMethods: string[],
): boolean {
	if (!config) {
		return false;
	}

	// `needsReauth` describes an OAuth GRANT and is cleared only by an OAuth
	// reconnect, so it disqualifies a credential only when the config is
	// actually on one. A row edited to API_KEY/NONE can still carry the flag
	// from an earlier OAuth life, and its current credential is unaffected by
	// it — reporting that as "needs reauthentication" sends the user to a
	// reconnect flow the config no longer has.
	if (config.authType === "OAUTH2" && config.needsReauth) {
		return false;
	}

	// Check based on auth type
	if (config.authType === "NONE") {
		return true;
	}

	if (config.authType === "API_KEY") {
		return !!config.encryptedApiKey;
	}

	if (config.authType === "OAUTH2") {
		// Need access token and it shouldn't be expired
		if (!config.encryptedAccessToken) {
			return false;
		}

		// Check if token is expired (with 5 minute buffer)
		if (config.tokenExpiresAt) {
			const expirationBuffer = 5 * 60 * 1000; // 5 minutes
			const isExpired =
				new Date(config.tokenExpiresAt).getTime() - expirationBuffer <
				Date.now();
			return !isExpired;
		}

		return true;
	}

	// If auth method is not recognized, assume valid if any credential exists
	return !!(config.encryptedApiKey || config.encryptedAccessToken);
}

// =============================================================================
// Helper: Determine preferred auth type from server's authMethods
// =============================================================================

function getPreferredAuthType(
	authMethods: string[],
): "OAUTH2" | "API_KEY" | "NONE" {
	// Prefer OAuth2 if available (better UX)
	if (authMethods.includes("OAUTH2")) {
		return "OAUTH2";
	}
	if (authMethods.includes("API_KEY")) {
		return "API_KEY";
	}
	return "NONE";
}

// =============================================================================
// Main Function: Detect Required Connections
// =============================================================================

/**
 * Detect MCP servers that need to be connected for the user's task.
 *
 * This function:
 * 1. Takes server names that matched the user's query via semantic search
 * 2. Checks which of those servers the user has valid credentials for
 * 3. Returns the servers that need connection as RequiredConnection objects
 *
 * The `matchedServerNames` should come from:
 * - Tool search results (tools the user already has access to)
 * - Registry search (system servers that could help but user hasn't connected)
 */
export async function detectRequiredConnections(
	input: DetectRequiredConnectionsInput,
): Promise<DetectRequiredConnectionsOutput> {
	const startTime = Date.now();
	console.log(
		`[DetectConnections] Checking connection status for user ${input.userId}`,
	);

	// If no matched servers provided, return empty
	if (!input.matchedServerNames || input.matchedServerNames.length === 0) {
		return {
			requiredConnections: [],
			hasRequiredConnections: false,
		};
	}

	// Get servers with their connection status
	const serversWithConfig = await getMcpServersWithConnectionStatus(
		input.userId,
		input.organizationId,
		input.matchedServerNames,
	);

	// Filter to servers that need connection
	const requiredConnections: RequiredConnection[] = [];

	for (const server of serversWithConfig) {
		const hasCredentials = hasValidCredentials(
			server.config,
			server.authMethods,
		);

		if (!hasCredentials) {
			const authType = getPreferredAuthType(server.authMethods);

			requiredConnections.push({
				serverId: server.id,
				serverName: server.name,
				reason: server.config?.needsReauth
					? `Your ${server.name} connection needs to be re-authenticated`
					: `Connect to ${server.name} to access its tools`,
				authType,
				isSystemProvided: server.isSystemProvided,
				iconUrl: server.iconUrl ?? undefined,
				category: server.category ?? undefined,
				confidence: 0.8, // Default confidence for detected servers
			});
		}
	}

	const durationMs = Date.now() - startTime;
	console.log(
		`[DetectConnections] Found ${requiredConnections.length} required connections in ${durationMs}ms`,
	);

	return {
		requiredConnections,
		hasRequiredConnections: requiredConnections.length > 0,
	};
}

// =============================================================================
// Search System Registry for Potentially Relevant Servers
// =============================================================================

/**
 * Search the MCP registry for system-provided servers that might help with the task.
 * This is used to discover servers the user hasn't connected yet.
 *
 * Uses simple keyword matching on server name, description, and category.
 * For more sophisticated matching, use the Qdrant semantic search.
 */
export async function searchSystemServersForTask(
	query: string,
	userId: string,
	organizationId?: string,
): Promise<
	Array<{
		server: McpServerWithConfig;
		matchScore: number;
		matchReason: string;
	}>
> {
	// Get all system servers
	const systemServers = await db.mCPServer.findMany({
		where: { isSystemProvided: true },
		select: {
			id: true,
			key: true,
			name: true,
			description: true,
			authMethods: true,
			isSystemProvided: true,
			iconUrl: true,
			category: true,
			tags: true,
		},
	});

	// Simple keyword matching
	const queryLower = query.toLowerCase();
	const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

	const matches: Array<{
		server: McpServerWithConfig;
		matchScore: number;
		matchReason: string;
	}> = [];

	for (const server of systemServers) {
		const serverNameLower = server.name.toLowerCase();
		const descriptionLower = (server.description || "").toLowerCase();
		const categoryLower = (server.category || "").toLowerCase();
		const tagsLower = (server.tags || []).map((t) => t.toLowerCase());

		let score = 0;
		const reasons: string[] = [];

		// Check for exact name match
		if (queryLower.includes(serverNameLower.split(" ")[0])) {
			score += 0.5;
			reasons.push("name match");
		}

		// Check for keyword matches
		for (const word of queryWords) {
			if (serverNameLower.includes(word)) {
				score += 0.2;
				reasons.push(`keyword "${word}" in name`);
			}
			if (descriptionLower.includes(word)) {
				score += 0.1;
				reasons.push(`keyword "${word}" in description`);
			}
			if (categoryLower.includes(word)) {
				score += 0.15;
				reasons.push(`keyword "${word}" in category`);
			}
			if (tagsLower.some((t) => t.includes(word))) {
				score += 0.1;
				reasons.push(`keyword "${word}" in tags`);
			}
		}

		if (score > 0.2) {
			// Get user's config status for this server
			const config = await db.mCPConfig.findFirst({
				where: {
					mcpServerId: server.id,
					userId,
					organizationId: organizationId ?? null,
				},
				select: {
					id: true,
					authType: true,
					encryptedApiKey: true,
					encryptedAccessToken: true,
					tokenExpiresAt: true,
					needsReauth: true,
				},
			});

			matches.push({
				server: {
					...server,
					config: config ?? null,
				},
				matchScore: Math.min(score, 1),
				matchReason: reasons.slice(0, 3).join(", "),
			});
		}
	}

	// Sort by score descending
	matches.sort((a, b) => b.matchScore - a.matchScore);

	return matches.slice(0, 5); // Return top 5 matches
}

/**
 * Detect required connections by searching both:
 * 1. Servers from existing tool search results (matchedServerNames)
 * 2. System registry servers that might help with the task
 *
 * This provides a more complete picture of what connections might be needed.
 */
export async function detectRequiredConnectionsWithRegistrySearch(
	input: DetectRequiredConnectionsInput & { searchRegistry?: boolean },
): Promise<DetectRequiredConnectionsOutput> {
	const startTime = Date.now();

	// Start with the basic detection
	const basicResult = await detectRequiredConnections(input);

	// If registry search is disabled or we already have enough connections, return
	if (!input.searchRegistry || basicResult.requiredConnections.length >= 3) {
		return basicResult;
	}

	// Search the system registry for potentially helpful servers
	const registryMatches = await searchSystemServersForTask(
		input.query,
		input.userId,
		input.organizationId,
	);

	// Add servers from registry that user doesn't have valid credentials for
	const existingServerIds = new Set(
		basicResult.requiredConnections.map((c) => c.serverId),
	);

	for (const match of registryMatches) {
		// Skip if already in results
		if (existingServerIds.has(match.server.id)) {
			continue;
		}

		const hasCredentials = hasValidCredentials(
			match.server.config,
			match.server.authMethods,
		);

		if (!hasCredentials) {
			const authType = getPreferredAuthType(match.server.authMethods);

			basicResult.requiredConnections.push({
				serverId: match.server.id,
				serverName: match.server.name,
				reason: match.server.config?.needsReauth
					? `Your ${match.server.name} connection needs to be re-authenticated`
					: `${match.server.name} might help with this task - ${match.matchReason}`,
				authType,
				isSystemProvided: match.server.isSystemProvided,
				iconUrl: match.server.iconUrl ?? undefined,
				category: match.server.category ?? undefined,
				confidence: match.matchScore,
			});

			existingServerIds.add(match.server.id);
		}
	}

	// Sort by confidence
	basicResult.requiredConnections.sort((a, b) => b.confidence - a.confidence);

	const durationMs = Date.now() - startTime;
	console.log(
		`[DetectConnections] Found ${basicResult.requiredConnections.length} required connections (with registry search) in ${durationMs}ms`,
	);

	return {
		requiredConnections: basicResult.requiredConnections,
		hasRequiredConnections: basicResult.requiredConnections.length > 0,
	};
}

// =============================================================================
// Alternative: Check Specific Server Connection
// =============================================================================

/**
 * Check if a specific MCP server is connected for the user.
 * Returns connection details if not connected.
 */
export async function checkServerConnection(
	serverId: string,
	userId: string,
	organizationId?: string,
): Promise<{
	isConnected: boolean;
	requiredConnection?: RequiredConnection;
}> {
	const server = await db.mCPServer.findUnique({
		where: { id: serverId },
		select: {
			id: true,
			key: true,
			name: true,
			description: true,
			authMethods: true,
			isSystemProvided: true,
			iconUrl: true,
			category: true,
		},
	});

	if (!server) {
		return { isConnected: false };
	}

	// Get user's config
	const config = await db.mCPConfig.findFirst({
		where: {
			mcpServerId: serverId,
			userId,
			organizationId: organizationId ?? null,
		},
		select: {
			id: true,
			authType: true,
			encryptedApiKey: true,
			encryptedAccessToken: true,
			tokenExpiresAt: true,
			needsReauth: true,
		},
	});

	const hasCredentials = hasValidCredentials(config, server.authMethods);

	if (hasCredentials) {
		return { isConnected: true };
	}

	const authType = getPreferredAuthType(server.authMethods);

	return {
		isConnected: false,
		requiredConnection: {
			serverId: server.id,
			serverName: server.name,
			reason: config?.needsReauth
				? `Your ${server.name} connection needs to be re-authenticated`
				: `Connect to ${server.name} to access its tools`,
			authType,
			isSystemProvided: server.isSystemProvided,
			iconUrl: server.iconUrl ?? undefined,
			category: server.category ?? undefined,
			confidence: 1.0,
		},
	};
}

// =============================================================================
// Detect Missing Workflow Integrations
// =============================================================================

export interface DetectMissingIntegrationsInput {
	/** User ID */
	userId: string;
	/** Organization ID (if in org context) */
	organizationId?: string;
	/** Matched integrations from routing semantic search */
	matchedIntegrations?: Array<{
		integrationId?: string;
		name: string;
		provider: string;
		confidence: number;
		capabilities?: string[];
	}>;
}

export interface MissingIntegration {
	/** Provider type (GITHUB, SLACK, etc.) */
	provider: string;
	/** Display name */
	name: string;
	/** Why this integration is needed */
	reason: string;
	/** Authentication type for this integration */
	authType: "OAUTH" | "API_KEY";
	/** Capabilities this integration provides */
	capabilities: string[];
	/** Confidence score */
	confidence: number;
}

export interface DetectMissingIntegrationsOutput {
	/** Integrations that need to be configured */
	missingIntegrations: MissingIntegration[];
	/** Whether there are any missing integrations */
	hasMissingIntegrations: boolean;
}

/**
 * Integration providers that support OAuth authentication
 */
const OAUTH_PROVIDERS = new Set([
	"GITHUB",
	"SLACK",
	"GOOGLE_DRIVE",
	"MICROSOFT_GRAPH",
	"NOTION",
]);

/**
 * Integration providers that use API Key authentication
 */
const _API_KEY_PROVIDERS = new Set([
	"LINEAR",
	"RESEND",
	"FIRECRAWL",
	"PERPLEXITY",
	"FAL",
	"CONFLUENCE",
]);

/**
 * Get auth type for a provider
 */
function getProviderAuthType(provider: string): "OAUTH" | "API_KEY" {
	if (OAUTH_PROVIDERS.has(provider.toUpperCase())) {
		return "OAUTH";
	}
	return "API_KEY";
}

/**
 * Detect workflow integrations that are matched but not configured.
 * This complements MCP connection detection for the full integration picture.
 */
export async function detectMissingIntegrations(
	input: DetectMissingIntegrationsInput,
): Promise<DetectMissingIntegrationsOutput> {
	const { userId, organizationId, matchedIntegrations } = input;

	if (!matchedIntegrations || matchedIntegrations.length === 0) {
		return {
			missingIntegrations: [],
			hasMissingIntegrations: false,
		};
	}

	const missingIntegrations: MissingIntegration[] = [];

	for (const matched of matchedIntegrations) {
		// Check if integration is configured in current context
		const hasCredentials = await checkIntegrationCredentials(
			matched.provider,
			userId,
			organizationId,
		);

		if (!hasCredentials) {
			missingIntegrations.push({
				provider: matched.provider,
				name: matched.name,
				reason: `Connect ${matched.name} to use this integration`,
				authType: getProviderAuthType(matched.provider),
				capabilities: matched.capabilities || [],
				confidence: matched.confidence,
			});
		}
	}

	console.log(
		`[DetectMissingIntegrations] Found ${missingIntegrations.length} missing integrations`,
		{
			missing: missingIntegrations.map(
				(i) => `${i.provider} (${i.authType})`,
			),
		},
	);

	return {
		missingIntegrations,
		hasMissingIntegrations: missingIntegrations.length > 0,
	};
}

/**
 * Check if user has credentials for a workflow integration provider
 * Enforces strict isolation between personal and organizational integrations
 */
async function checkIntegrationCredentials(
	provider: string,
	userId: string,
	organizationId?: string,
): Promise<boolean> {
	// Strict isolation: personal context requires organizationId to be null
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const integration = await db.workflowIntegration.findFirst({
		where: {
			provider: provider as any,
			userId,
			...orgFilter,
			isActive: true,
		},
	});

	return !!integration;
}
