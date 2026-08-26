/**
 * Tool Search
 *
 * Implements the "Tool Search Tool" pattern from Anthropic's Advanced Tool Use.
 * Instead of loading all MCP tool definitions upfront (77K+ tokens),
 * this tool searches for relevant tools on-demand (~500 tokens for the search tool itself).
 *
 * Token savings: 85% reduction (77K → 8.7K tokens)
 *
 * IMPROVED (Anthropic Tool Search Pattern):
 * 1. BM25-First Search - Check KEYWORDS matches BEFORE semantic search
 * 2. Always-Available Capabilities - Frequently used tools bypass search
 * 3. Hybrid Scoring - Combine keyword + semantic for best results
 */

import { closeMcpClientSafe, getMcpClient } from "@repo/agent-core/backend";
import { db } from "@repo/database";
import { GITHUB_ACCOUNT, MICROSOFT_TEAMS_ACCOUNT } from "@repo/mcp-registry";
import type { TenantContext } from "@repo/rag/lib/embedding/types";
import { getCapabilitiesByTenant } from "@repo/rag/lib/vector-store/capability-store";
import { ingestOAuthIntegrationToolsActivity } from "../../oauth-tool-ingestion";
import {
	type CapabilityWithKeywords,
	type KeywordMatch,
	matchAlwaysAvailableCapabilities,
	searchByKeywords,
	toolToCapabilityWithKeywords,
} from "./capability-keywords";
import { type FabricAiTool, getFabricAiTools } from "./fabric-ai-tools";
import {
	type ToolCategory,
	type ToolSearchResult,
	toolIndex,
} from "./tool-index";
import type {
	SearchAvailableToolsInput,
	SearchAvailableToolsOutput,
} from "./types";

function unwrapToolInputSchema(
	inputSchema?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (
		inputSchema &&
		typeof inputSchema === "object" &&
		"jsonSchema" in inputSchema &&
		inputSchema.jsonSchema &&
		typeof inputSchema.jsonSchema === "object"
	) {
		return inputSchema.jsonSchema as Record<string, unknown>;
	}

	return inputSchema;
}

function determineRiskLevel(
	toolName: string,
): "low" | "medium" | "high" | "critical" {
	const nameLower = toolName.toLowerCase();

	if (
		nameLower.includes("delete") ||
		nameLower.includes("remove") ||
		nameLower.includes("drop") ||
		nameLower.includes("destroy")
	) {
		return "critical";
	}

	if (
		nameLower.includes("create") ||
		nameLower.includes("update") ||
		nameLower.includes("modify") ||
		nameLower.includes("write") ||
		nameLower.includes("send") ||
		nameLower.includes("post") ||
		nameLower.includes("put")
	) {
		return "high";
	}

	if (
		nameLower.includes("fetch") ||
		nameLower.includes("download") ||
		nameLower.includes("export")
	) {
		return "medium";
	}

	return "low";
}

function isReadOnlyTool(toolName: string): boolean {
	const nameLower = toolName.toLowerCase();
	const readOnlyPatterns = [
		"get",
		"list",
		"search",
		"find",
		"query",
		"read",
		"view",
		"show",
		"describe",
		"info",
		"status",
		"check",
	];

	return readOnlyPatterns.some((pattern) => nameLower.includes(pattern));
}

function inferCategory(
	toolName: string,
	description?: string,
	serverName?: string,
): ToolCategory {
	const combined =
		`${toolName} ${description || ""} ${serverName || ""}`.toLowerCase();

	if (
		combined.includes("search") ||
		combined.includes("web") ||
		combined.includes("scrape") ||
		combined.includes("crawl")
	) {
		return "search";
	}
	if (
		combined.includes("file") ||
		combined.includes("document") ||
		combined.includes("storage")
	) {
		return "file";
	}
	if (
		combined.includes("github") ||
		combined.includes("git") ||
		combined.includes("code") ||
		combined.includes("repository")
	) {
		return "development";
	}
	if (
		combined.includes("slack") ||
		combined.includes("email") ||
		combined.includes("message") ||
		combined.includes("notification")
	) {
		return "communication";
	}
	if (
		combined.includes("database") ||
		combined.includes("sql") ||
		combined.includes("query") ||
		combined.includes("data")
	) {
		return "data";
	}
	if (
		combined.includes("project") ||
		combined.includes("task") ||
		combined.includes("board") ||
		combined.includes("issue") ||
		combined.includes("ticket")
	) {
		return "project_management";
	}

	return "unknown";
}

// =============================================================================
// MCP Server Detection
// =============================================================================

/**
 * Detects explicit MCP server name mentions in user query.
 * Returns server names that should be prioritized/filtered to.
 *
 * Patterns detected:
 * - "use context7 mcp to..."
 * - "use the context7 server..."
 * - "with firecrawl..."
 * - "using fizzy mcp..."
 * - "delete boards in Fizzy" (action in/on service)
 * - "create a card on Fizzy"
 */
export function detectExplicitServerMention(
	query: string,
	availableServerNames: string[],
): { matchedServers: string[]; isExplicitRequest: boolean } {
	const queryLower = query.toLowerCase();

	// Patterns that indicate explicit server request
	const explicitPatterns = [
		/use\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
		/using\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
		/with\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
		/via\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
		/from\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
	];

	const matchedServers: string[] = [];
	let isExplicitRequest = false;

	// Check each available server name
	for (const serverName of availableServerNames) {
		const serverLower = serverName.toLowerCase();
		// Remove common suffixes for matching
		const normalizedServer = serverLower
			.replace(/\s*(mcp|server|api|service)$/i, "")
			.trim();

		// Check if query explicitly mentions this server
		for (const pattern of explicitPatterns) {
			pattern.lastIndex = 0; // Reset regex
			const matches = queryLower.matchAll(pattern);
			for (const match of matches) {
				const mentioned = match[1]?.toLowerCase().trim();
				if (mentioned) {
					// Check if the mentioned term matches the server name
					if (
						serverLower.includes(mentioned) ||
						normalizedServer.includes(mentioned) ||
						mentioned.includes(normalizedServer) ||
						mentioned.includes(serverLower.split(" ")[0])
					) {
						if (!matchedServers.includes(serverName)) {
							matchedServers.push(serverName);
							isExplicitRequest = true;
						}
					}
				}
			}
		}

		// Also check for direct mentions without patterns (e.g., "context7 query")
		if (
			queryLower.includes(normalizedServer) ||
			queryLower.includes(serverLower.split(" ")[0])
		) {
			// Check it's not just a substring of another word
			const serverWord = normalizedServer || serverLower.split(" ")[0];
			const wordBoundary = new RegExp(`\\b${serverWord}\\b`, "i");
			if (wordBoundary.test(query)) {
				if (!matchedServers.includes(serverName)) {
					matchedServers.push(serverName);
					// Mark as explicit request if server name appears with context keywords
					// Including "in X", "on X", "from X", "X assignment", "X task", "X project" patterns
					const contextPattern = new RegExp(
						`(?:use|using|with|via|mcp|server|in|on|from)\\s+(?:the\\s+)?${serverWord}\\b|\\b${serverWord}\\s+(?:mcp|server|api|tool|assignment|task|project|board|card|ticket|issue)\\b`,
						"i",
					);
					if (contextPattern.test(query)) {
						isExplicitRequest = true;
					}
				}
			}
		}
	}

	return { matchedServers, isExplicitRequest };
}

/**
 * Get available server names from database without connecting to servers.
 * This is a lightweight operation that only queries the database.
 */
export async function getAvailableServerNames(
	userId: string,
	organizationId: string | undefined,
	enabledMcpConfigIds?: string[] | null,
): Promise<string[]> {
	// SECURITY: Strict tenant isolation - per-user configs even within orgs
	// Each user has their own MCP configs, even in organization context
	const mcpConfigs = await db.mCPConfig.findMany({
		where: {
			userId,
			organizationId: organizationId ?? null,
			enabled: true,
			...(enabledMcpConfigIds ? { id: { in: enabledMcpConfigIds } } : {}),
		},
		include: { mcpServer: true },
	});

	return mcpConfigs.map(
		(config) => config.displayName || config.mcpServer?.name || config.id,
	);
}

/**
 * Find relevant MCP servers using semantic similarity (Phase 1)
 *
 * Uses embeddings in Qdrant to match queries to servers based on semantic meaning
 * instead of hardcoded regex patterns. This scales to 100+ servers without maintenance.
 *
 * Research-backed approach:
 * - 85-90% accuracy at 10-50ms latency
 * - Self-configuring (servers define their own metadata)
 * - No manual keyword updates needed
 *
 * @returns Server names ranked by semantic similarity, with confidence scores
 */
export async function findRelevantServersBySemantic(
	query: string,
	userId: string,
	organizationId: string | undefined,
	options: {
		/** Minimum similarity threshold (0-1). Default: 0.7 for high confidence */
		minScore?: number;
		/** Maximum number of servers to return. Default: 3 */
		limit?: number;
		/** Whether to include results below threshold as fallback. Default: false */
		includeLowConfidence?: boolean;
	} = {},
): Promise<{
	serverNames: string[];
	scores: number[];
	isHighConfidence: boolean;
}> {
	const { minScore = 0.7, limit = 3, includeLowConfidence = false } = options;

	try {
		// Import here to avoid circular dependency issues
		const { generateEmbeddings } = await import(
			"@repo/rag/lib/embedding/generator"
		);
		const { searchCapabilities } = await import(
			"@repo/rag/lib/vector-store/capability-store"
		);
		const { getRAGProviderConfig } = await import("@repo/ai");

		// Generate embedding for query
		const providerConfig = await getRAGProviderConfig({
			userId,
			organizationId,
		});

		const embeddingResult = await generateEmbeddings(
			[query],
			{ userId, organizationId },
			providerConfig,
		);

		if (
			!embeddingResult.embeddings ||
			embeddingResult.embeddings.length === 0
		) {
			console.warn(
				"[SearchTools] Failed to generate query embedding for server search",
			);
			return { serverNames: [], scores: [], isHighConfidence: false };
		}

		// Search Qdrant for mcp_server type with semantic similarity
		const results = await searchCapabilities({
			queryEmbedding: embeddingResult.embeddings[0],
			type: "mcp_server",
			userId,
			organizationId,
			includeSystem: false, // Only user's own servers
			minScore: includeLowConfidence ? 0.3 : minScore,
			limit,
		});

		if (results.length === 0) {
			return { serverNames: [], scores: [], isHighConfidence: false };
		}

		// Extract server names and scores
		const serverNames = results.map((r) => r.capability.name);
		const scores = results.map((r) => r.score);

		// High confidence if best result is above threshold
		const isHighConfidence =
			results.length > 0 && results[0].score >= minScore;

		console.log("[SearchTools] Semantic server search results:", {
			query,
			topServer: serverNames[0],
			topScore: scores[0]?.toFixed(3),
			totalResults: results.length,
			isHighConfidence,
		});

		return { serverNames, scores, isHighConfidence };
	} catch (error) {
		console.error("[SearchTools] Semantic server search failed:", error);
		return { serverNames: [], scores: [], isHighConfidence: false };
	}
}

/**
 * Fetch tools from explicitly mentioned servers ONLY.
 * This avoids connecting to all MCP servers when user explicitly requested specific ones.
 * Returns null if fetch fails (caller should fall back to full index).
 */
export async function fetchToolsFromExplicitServers(
	userId: string,
	organizationId: string | undefined,
	matchedServers: string[],
	enabledMcpConfigIds?: string[] | null,
	startTime?: number,
): Promise<SearchAvailableToolsOutput | null> {
	console.log(
		`[SearchTools] Fetching tools from explicit server(s) only: ${matchedServers.join(", ")}`,
	);

	// Get MCP configs that match the requested server names
	// SECURITY: Per-user isolation - each user has their own configs even within orgs
	const mcpConfigs = await db.mCPConfig.findMany({
		where: {
			userId,
			organizationId: organizationId ?? null,
			enabled: true,
			...(enabledMcpConfigIds ? { id: { in: enabledMcpConfigIds } } : {}),
		},
		include: { mcpServer: true },
	});

	// Filter configs to only those matching requested servers
	const matchingConfigs = mcpConfigs.filter((config) => {
		const configName = (
			config.displayName ||
			config.mcpServer?.name ||
			config.id
		).toLowerCase();
		const normalizedConfigName = configName
			.replace(/\s*(mcp|server|api|service)$/i, "")
			.trim();

		return matchedServers.some((server) => {
			const serverLower = server.toLowerCase();
			const normalizedServer = serverLower
				.replace(/\s*(mcp|server|api|service)$/i, "")
				.trim();
			return (
				configName.includes(normalizedServer) ||
				normalizedConfigName.includes(normalizedServer) ||
				normalizedServer.includes(normalizedConfigName)
			);
		});
	});

	if (matchingConfigs.length === 0) {
		console.warn(
			`[SearchTools] No MCP configs found matching servers: ${matchedServers.join(", ")}`,
		);
		return null;
	}

	console.log(
		`[SearchTools] Found ${matchingConfigs.length} matching MCP config(s), connecting ONLY to these`,
	);

	// Fetch tools from ONLY the matching servers
	const results: SearchAvailableToolsOutput["results"] = [];

	for (const config of matchingConfigs) {
		const configName =
			config.displayName || config.mcpServer?.name || config.id;
		const serverUrl = config.baseUrl || config.mcpServer?.defaultUrl;
		const isStdio = config.mcpServer?.transport === "STDIO";

		if (!serverUrl && !isStdio) {
			console.warn(
				`[SearchTools] Skipping config ${configName} - no server URL and not STDIO`,
			);
			continue;
		}

		try {
			const result = await getMcpClient(
				config.id,
				userId,
				organizationId,
			);
			if (!result) {
				console.warn(
					`[SearchTools] getMcpClient returned null for ${configName}`,
				);
				continue;
			}

			const { client, serverName } = result;
			const tools = await client.tools();

			// Add all tools from this server
			for (const [toolName, toolDef] of Object.entries(tools)) {
				const def = toolDef as {
					description?: string;
					inputSchema?: Record<string, unknown>;
				};
				results.push({
					toolId: `${config.id}:${toolName}`,
					serverName,
					toolName,
					description: def.description || "",
					confidence: 0.85, // High confidence for explicitly requested server
					matchReason: `Explicitly requested server: ${serverName}`,
					configId: config.id,
					riskLevel: "medium", // Default risk level for explicitly requested tools
					isReadOnly: false, // Default to false, can be refined later
					inputSchema: unwrapToolInputSchema(def.inputSchema),
				});
			}

			await closeMcpClientSafe(client);
			console.log(
				`[SearchTools] Loaded ${Object.keys(tools).length} tools from ${serverName}`,
			);
		} catch (error) {
			console.warn(
				`[SearchTools] Failed to fetch tools from ${configName}:`,
				error,
			);
		}
	}

	if (results.length === 0) {
		console.warn("[SearchTools] No tools fetched from explicit servers");
		return null;
	}

	const durationMs = startTime ? Date.now() - startTime : 0;
	console.log(
		`[SearchTools] Found ${results.length} tools from explicit server(s) in ${durationMs}ms`,
	);

	return {
		results,
		totalToolsSearched: results.length,
		semanticSearchUsed: false, // Direct fetch, no semantic search
		durationMs,
	};
}

/**
 * Fetch ALL tools from specific MCP server IDs (bypasses semantic search).
 * Used for prioritized servers to ensure their tools are always available.
 */
export async function fetchToolsFromServerIds(
	serverConfigIds: string[],
	userId: string,
	organizationId?: string,
): Promise<
	Array<{
		toolName: string;
		description: string;
		configId: string;
		serverName: string;
		category?: ToolCategory;
		riskLevel: "low" | "medium" | "high" | "critical";
		isReadOnly: boolean;
		inputSchema?: Record<string, unknown>;
	}>
> {
	const tools: Array<{
		toolName: string;
		description: string;
		configId: string;
		serverName: string;
		category?: ToolCategory;
		riskLevel: "low" | "medium" | "high" | "critical";
		isReadOnly: boolean;
		inputSchema?: Record<string, unknown>;
	}> = [];

	// Get MCP configs for the specified IDs
	// SECURITY: Per-user isolation - each user has their own configs even within orgs
	const mcpConfigs = await db.mCPConfig.findMany({
		where: {
			id: { in: serverConfigIds },
			userId,
			organizationId: organizationId ?? null,
			enabled: true,
		},
		include: { mcpServer: true },
	});

	console.log(
		`[SearchTools] Fetching tools directly from ${mcpConfigs.length} prioritized servers`,
	);

	for (const config of mcpConfigs) {
		const serverName =
			config.displayName || config.mcpServer?.name || config.id;
		try {
			const result = await getMcpClient(
				config.id,
				userId,
				organizationId,
			);
			if (!result) {
				console.warn(
					`[SearchTools] getMcpClient returned null for ${serverName}`,
				);
				continue;
			}

			const { client } = result;
			const serverTools = await client.tools();

			for (const [toolName, tool] of Object.entries(serverTools)) {
				const typedTool = tool as {
					description?: string;
					inputSchema?: Record<string, unknown>;
				};
				tools.push({
					toolName,
					description:
						typedTool.description || `Tool from ${serverName}`,
					configId: config.id,
					serverName,
					category: inferCategory(
						toolName,
						typedTool.description,
						serverName,
					),
					riskLevel: determineRiskLevel(toolName),
					isReadOnly: isReadOnlyTool(toolName),
					inputSchema: unwrapToolInputSchema(typedTool.inputSchema),
				});
			}

			await closeMcpClientSafe(client);
			console.log(
				`[SearchTools] Fetched ${Object.keys(serverTools).length} tools from ${serverName}`,
			);
		} catch (error) {
			console.warn(
				`[SearchTools] Failed to fetch tools from ${serverName}:`,
				error,
			);
		}
	}

	return tools;
}

// =============================================================================
// Pre-load MCP Tools for Focused Agents
// =============================================================================

/**
 * Temporal activity: pre-load ALL tools from specific MCP config IDs.
 *
 * Used when an agent has specific MCP servers assigned to its knowledge base
 * (enabledMcpConfigIds is non-empty). By loading these tools before the first
 * LLM iteration we avoid requiring the model to call search_tools first —
 * the tools are immediately available, making focused agents reliable.
 */
export async function preloadMcpToolsForConfigsActivity(params: {
	enabledMcpConfigIds: string[];
	userId: string;
	organizationId?: string;
}): Promise<
	Array<{
		toolName: string;
		description: string;
		configId: string;
		serverName: string;
		inputSchema?: Record<string, unknown>;
	}>
> {
	const { enabledMcpConfigIds, userId, organizationId } = params;

	console.log(
		`[PreloadMcpTools] Pre-loading tools from ${enabledMcpConfigIds.length} assigned MCP config(s)`,
		{ enabledMcpConfigIds },
	);

	const tools = await fetchToolsFromServerIds(
		enabledMcpConfigIds,
		userId,
		organizationId,
	);

	console.log(
		`[PreloadMcpTools] Pre-loaded ${tools.length} tools from assigned MCP server(s)`,
	);

	return tools;
}

// =============================================================================
// OAuth Tool Version Management
// =============================================================================

/**
 * Check if OAuth integration tools need updating based on version
 *
 * Uses metadata filtering to efficiently query just the tools for this integration.
 * This avoids pagination issues where fetching 10 arbitrary tools might miss the integration.
 */
async function getOAuthToolVersion(
	userId: string,
	organizationId: string | undefined,
	integrationId: string,
): Promise<string | null> {
	try {
		const configId = `oauth:integration:${integrationId}`;

		// Query with configId metadata filter - only fetches tools from this integration
		// This is efficient even if the tenant has 1000+ tools from other sources
		const capabilities = await getCapabilitiesByTenant(
			userId,
			organizationId,
			"mcp_tool",
			1, // Only need one tool to check version (all tools from same integration have same version)
			{ configId }, // Metadata filter
		);

		if (capabilities.length > 0) {
			return (
				((
					capabilities[0].capability.metadata as Record<
						string,
						unknown
					>
				)?.version as string) || null
			);
		}

		return null;
	} catch (error) {
		console.warn(
			`[ToolSync] Failed to get OAuth tool version for ${integrationId}:`,
			error,
		);
		return null;
	}
}

/**
 * Sync OAuth integration tools if registry version changed
 * Returns true if sync was performed
 */
async function syncOAuthToolsIfNeeded(
	userId: string,
	organizationId: string | undefined,
): Promise<boolean> {
	try {
		let syncPerformed = false;

		// Check Microsoft Teams integration
		const msIntegration = organizationId
			? await db.workflowIntegration.findFirst({
					where: {
						organizationId,
						provider: "MICROSOFT_GRAPH",
						isActive: true,
					},
				})
			: await db.workflowIntegration.findFirst({
					where: {
						userId,
						organizationId: null,
						provider: "MICROSOFT_GRAPH",
						isActive: true,
					},
				});

		if (msIntegration) {
			const qdrantVersion = await getOAuthToolVersion(
				userId,
				organizationId,
				msIntegration.id,
			);
			const registryVersion = MICROSOFT_TEAMS_ACCOUNT.version || "1.0.0";

			if (qdrantVersion !== registryVersion) {
				console.log(
					`[ToolSync] Microsoft Teams tools outdated (${qdrantVersion || "none"} → ${registryVersion}), re-ingesting...`,
				);
				await ingestOAuthIntegrationToolsActivity({
					integrationId: msIntegration.id,
					provider: "MICROSOFT_GRAPH",
					userId,
					organizationId,
				});
				syncPerformed = true;
			}
		}

		// Check GitHub integration (with tenant isolation)
		const ghIntegration = organizationId
			? await db.workflowIntegration.findFirst({
					where: {
						organizationId,
						provider: "GITHUB",
						isActive: true,
					},
				})
			: await db.workflowIntegration.findFirst({
					where: {
						userId,
						organizationId: null,
						provider: "GITHUB",
						isActive: true,
					},
				});

		if (ghIntegration) {
			const qdrantVersion = await getOAuthToolVersion(
				userId,
				organizationId,
				ghIntegration.id,
			);
			const registryVersion = GITHUB_ACCOUNT.version || "1.0.0";

			if (qdrantVersion !== registryVersion) {
				console.log(
					`[ToolSync] GitHub tools outdated (${qdrantVersion || "none"} → ${registryVersion}), re-ingesting...`,
				);
				await ingestOAuthIntegrationToolsActivity({
					integrationId: ghIntegration.id,
					provider: "GITHUB",
					userId,
					organizationId,
				});
				syncPerformed = true;
			}
		}

		return syncPerformed;
	} catch (error) {
		console.warn("[ToolSync] Failed to sync OAuth tools:", error);
		return false;
	}
}

// =============================================================================
// Tool Index Management
// =============================================================================

/**
 * Ensure the tool index is built and fresh.
 *
 * OPTIMIZATION: First tries to load from Qdrant cache (fast, no MCP connections).
 * Only connects to MCP servers if Qdrant cache is empty or unavailable.
 *
 * VERSION SYNC: Checks OAuth integration tools for version updates and re-ingests if needed.
 */
export async function ensureToolIndexBuilt(
	userId: string,
	organizationId: string | undefined,
	enabledMcpConfigIds?: string[] | null,
	enabledIntegrationIds?: string[] | null,
	enabledFabricToolIds?: string[] | null,
): Promise<void> {
	// SECURITY: Credentials are fetched internally by generateEmbedding()
	// API keys are NOT passed to avoid storing them in Temporal history
	// Check if rebuild is needed
	if (!toolIndex.needsRebuild(userId, organizationId)) {
		return;
	}

	// VERSION SYNC: Check if OAuth tools need updating (version-based sync)
	// This happens before Qdrant load so updated tools are available
	console.log("[SearchTools] Checking OAuth tool versions...");
	const oauthSyncPerformed = await syncOAuthToolsIfNeeded(
		userId,
		organizationId,
	);
	if (oauthSyncPerformed) {
		console.log(
			"[SearchTools] OAuth tools re-ingested due to version update",
		);
	}

	// OPTIMIZATION: Try loading from Qdrant cache first (no MCP connections needed)
	// This is much faster than connecting to all MCP servers
	console.log(
		"[SearchTools] Tool index cache expired, attempting Qdrant cache load...",
	);
	const loadedFromQdrant = await toolIndex.loadFromQdrant(
		userId,
		organizationId,
		enabledMcpConfigIds,
		enabledIntegrationIds,
		enabledFabricToolIds,
	);

	if (loadedFromQdrant) {
		console.log(
			"[SearchTools] Successfully loaded tools from Qdrant cache (no MCP connections)",
		);
		// Still need to add Fabric AI tools - check if they're already in the loaded index
		const fabricAiTools = getFabricAiTools();
		const existingFabricTools = toolIndex.getServerTools("Fabric AI");

		// Re-index if: no existing tools OR count mismatch OR schemas missing
		// Check if existing tools have inputSchema (critical for LLM to generate correct params)
		const hasSchemas = existingFabricTools.some(
			(t) => t.inputSchema && Object.keys(t.inputSchema).length > 0,
		);
		const needsReindex =
			existingFabricTools.length === 0 ||
			existingFabricTools.length !== fabricAiTools.length ||
			!hasSchemas; // Force re-index if schemas are missing

		if (fabricAiTools.length > 0 && needsReindex) {
			// Fabric AI tools not in Qdrant yet OR count changed OR schemas missing - invalidate and re-add
			const reason =
				existingFabricTools.length === 0
					? "no existing tools"
					: existingFabricTools.length !== fabricAiTools.length
						? "count mismatch"
						: !hasSchemas
							? "schemas missing (critical for LLM)"
							: "unknown";
			console.log(
				`[SearchTools] Re-indexing Fabric AI tools (reason: ${reason}, existing: ${existingFabricTools.length}, new: ${fabricAiTools.length}, hasSchemas: ${hasSchemas})`,
			);
			await toolIndex.addServer(
				"fabric-ai-server",
				"Fabric AI",
				fabricAiTools,
				{
					userId,
					organizationId,
					persistToQdrant: true, // Persist so they're searchable via Qdrant
					// providerConfig is no longer needed - credentials fetched internally
				},
			);
			console.log(
				`[SearchTools] Added ${fabricAiTools.length} Fabric AI tools to index`,
			);
		} else if (existingFabricTools.length > 0) {
			console.log(
				`[SearchTools] Fabric AI tools already in index (${existingFabricTools.length} tools)`,
			);
		}
		return;
	}

	// Qdrant cache miss - need to fetch from MCP servers
	console.log(
		"[SearchTools] Qdrant cache miss, connecting to MCP servers...",
	);

	// Get enabled MCP configs
	// SECURITY: Per-user isolation - each user has their own configs even within orgs
	const mcpConfigs = await db.mCPConfig.findMany({
		where: {
			userId,
			organizationId: organizationId ?? null,
			enabled: true,
			...(enabledMcpConfigIds ? { id: { in: enabledMcpConfigIds } } : {}),
		},
		include: { mcpServer: true },
	});

	// Fetch tools from each server
	const configs: Array<{
		id: string;
		serverName: string;
		tools: Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, unknown>;
		}>;
	}> = [];

	for (const config of mcpConfigs) {
		const configName =
			config.displayName || config.mcpServer?.name || config.id;
		const serverUrl = config.baseUrl || config.mcpServer?.defaultUrl;

		// Skip configs without a valid URL (but allow STDIO servers which have no URL)
		const isStdio = config.mcpServer?.transport === "STDIO";
		if (!serverUrl && !isStdio) {
			console.warn(
				`[SearchTools] Skipping config ${configName} - no server URL configured and not STDIO`,
			);
			continue;
		}

		try {
			const result = await getMcpClient(
				config.id,
				userId,
				organizationId,
			);
			if (!result) {
				console.warn(
					`[SearchTools] getMcpClient returned null for ${configName}`,
				);
				continue;
			}

			const { client, serverName } = result;
			const tools = await client.tools();

			const toolList = Object.entries(tools).map(([name, def]) => {
				const toolDef = def as {
					description?: string;
					inputSchema?: Record<string, unknown>;
				};
				return {
					name,
					description: toolDef.description,
					inputSchema: toolDef.inputSchema,
				};
			});

			configs.push({
				id: config.id,
				serverName,
				tools: toolList,
			});

			await closeMcpClientSafe(client);
		} catch (error) {
			console.warn(
				`[SearchTools] Failed to fetch tools from ${configName} (${serverUrl}):`,
				error,
			);
		}
	}

	// Add Fabric AI tools as a virtual server (system-level tools)
	const fabricAiTools = getFabricAiTools();
	if (fabricAiTools.length > 0) {
		configs.push({
			id: "fabric-ai-server",
			serverName: "Fabric AI",
			tools: fabricAiTools,
		});
		console.log(
			`[SearchTools] Added ${fabricAiTools.length} Fabric AI tools to index`,
		);
	}

	// Build the index
	await toolIndex.buildIndex({
		configs,
		generateEmbeddings: false, // Start without embeddings for speed
		tenantContext: { userId, organizationId },
		// providerConfig is no longer needed - credentials are fetched internally
	});
}

/**
 * Force rebuild the tool index (for cache invalidation).
 * SECURITY: Credentials are fetched internally by generateEmbedding()
 * API keys are NOT passed to avoid storing them in Temporal history
 */
export async function rebuildToolIndex(
	userId: string,
	organizationId: string | undefined,
	enabledMcpConfigIds?: string[] | null,
	generateEmbeddings = false,
): Promise<{ toolCount: number; serverCount: number }> {
	console.log("[SearchTools] Force rebuilding tool index...");

	// Clear existing index
	toolIndex.clear();

	// Get enabled MCP configs
	// SECURITY: Strict tenant isolation
	// Per-user-within-org pattern: configs have both userId AND organizationId set
	// Always filter by userId to prevent credential leakage between org members
	const mcpConfigs = await db.mCPConfig.findMany({
		where: {
			userId, // Always filter by current user (credentials are per-user)
			...(organizationId ? { organizationId } : { organizationId: null }),
			enabled: true,
			...(enabledMcpConfigIds ? { id: { in: enabledMcpConfigIds } } : {}),
		},
		include: { mcpServer: true },
	});

	// Fetch tools from each server
	const configs: Array<{
		id: string;
		serverName: string;
		tools: Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, unknown>;
		}>;
	}> = [];

	for (const config of mcpConfigs) {
		const configName =
			config.displayName || config.mcpServer?.name || config.id;
		const serverUrl = config.baseUrl || config.mcpServer?.defaultUrl;

		// Skip configs without a valid URL (but allow STDIO servers which have no URL)
		const isStdio = config.mcpServer?.transport === "STDIO";
		if (!serverUrl && !isStdio) {
			console.warn(
				`[SearchTools] Skipping config ${configName} - no server URL configured and not STDIO`,
			);
			continue;
		}

		try {
			const result = await getMcpClient(
				config.id,
				userId,
				organizationId,
			);
			if (!result) {
				console.warn(
					`[SearchTools] getMcpClient returned null for ${configName}`,
				);
				continue;
			}

			const { client, serverName } = result;
			const tools = await client.tools();

			const toolList = Object.entries(tools).map(([name, def]) => {
				const toolDef = def as {
					description?: string;
					inputSchema?: Record<string, unknown>;
				};
				return {
					name,
					description: toolDef.description,
					inputSchema: toolDef.inputSchema,
				};
			});

			configs.push({
				id: config.id,
				serverName,
				tools: toolList,
			});

			await closeMcpClientSafe(client);
		} catch (error) {
			console.warn(
				`[SearchTools] Failed to fetch tools from ${configName} (${serverUrl}):`,
				error,
			);
		}
	}

	// Add Fabric AI tools as a virtual server
	const fabricAiTools = getFabricAiTools();
	if (fabricAiTools.length > 0) {
		configs.push({
			id: "fabric-ai-server",
			serverName: "Fabric AI",
			tools: fabricAiTools,
		});
	}

	// Build the index with optional embeddings
	// Credentials are fetched internally by generateEmbedding()
	await toolIndex.buildIndex({
		configs,
		generateEmbeddings,
		tenantContext: { userId, organizationId },
	});

	const stats = toolIndex.getStats();
	return {
		toolCount: stats.totalTools,
		serverCount: stats.servers,
	};
}

// =============================================================================
// Helper Functions for Hybrid Search
// =============================================================================

/**
 * Convert keyword matches to SearchAvailableToolsOutput results format.
 */
function convertKeywordMatchesToResults(
	keywordMatches: KeywordMatch[],
	fabricAiTools: FabricAiTool[],
): SearchAvailableToolsOutput["results"] {
	const toolMap = new Map(fabricAiTools.map((t) => [t.name, t]));

	return keywordMatches.map((match) => {
		const tool = toolMap.get(match.id);
		return {
			toolId: match.id,
			serverName: (match.metadata?.serverName as string) || "Fabric AI",
			toolName: match.id,
			description: match.description,
			confidence: match.confidence,
			matchReason: match.matchReason,
			riskLevel: "low" as const,
			isReadOnly: true,
			configId:
				(match.metadata?.configId as string) || "fabric-ai-server",
			inputSchema:
				tool?.inputSchema ||
				(match.metadata?.inputSchema as Record<string, unknown>),
		};
	});
}

function convertIndexedResultsToOutput(
	results: ToolSearchResult[],
): SearchAvailableToolsOutput["results"] {
	return results.map((result) => ({
		toolId: result.tool.id,
		serverName: result.tool.serverName,
		toolName: result.tool.toolName,
		description: result.tool.description,
		confidence: result.confidence,
		matchReason: result.matchReason,
		category: result.tool.category,
		riskLevel: result.tool.riskLevel,
		isReadOnly: result.tool.isReadOnly,
		configId: result.tool.configId,
		inputSchema: result.tool.inputSchema,
	}));
}

/**
 * Merge keyword/semantic results with always-available matches.
 * Deduplicates and takes the higher confidence for duplicates.
 */
function mergeResults(
	results: SearchAvailableToolsOutput["results"],
	alwaysAvailableMatches: KeywordMatch[],
	fabricAiTools: FabricAiTool[],
): SearchAvailableToolsOutput["results"] {
	const resultMap = new Map(results.map((r) => [r.toolName, r]));

	// Add always-available matches that aren't already in results
	// or have higher confidence than existing matches
	for (const match of alwaysAvailableMatches) {
		const existing = resultMap.get(match.id);
		if (!existing || match.confidence > existing.confidence) {
			const tool = fabricAiTools.find((t) => t.name === match.id);
			resultMap.set(match.id, {
				toolId: match.id,
				serverName: "Fabric AI",
				toolName: match.id,
				description: match.description,
				confidence: match.confidence,
				matchReason: `Always-available: ${match.matchReason}`,
				riskLevel: "low",
				isReadOnly: true,
				configId: "fabric-ai-server",
				inputSchema: tool?.inputSchema,
			});
		}
	}

	// Sort by confidence and return
	return Array.from(resultMap.values()).sort(
		(a, b) => b.confidence - a.confidence,
	);
}

/**
 * Merge explicit server results with always-available matches.
 */
function _mergeWithAlwaysAvailable(
	explicitResult: SearchAvailableToolsOutput,
	alwaysAvailableMatches: KeywordMatch[],
	startTime: number,
): SearchAvailableToolsOutput {
	if (alwaysAvailableMatches.length === 0) {
		return explicitResult;
	}

	// Get Fabric AI tools for schema lookup
	const fabricAiTools = getFabricAiTools();
	const mergedResults = mergeResults(
		explicitResult.results,
		alwaysAvailableMatches,
		fabricAiTools,
	);

	return {
		...explicitResult,
		results: mergedResults,
		durationMs: Date.now() - startTime,
	};
}

// =============================================================================
// Main Search Function
// =============================================================================

/**
 * Search for available MCP tools that match the query.
 *
 * HYBRID BM25-FIRST SEARCH (Anthropic Tool Search Pattern):
 * 1. Check "always-available" capabilities first (workspace, youtube transcript, etc.)
 * 2. Run BM25 keyword search using KEYWORDS sections from tool descriptions
 * 3. If BM25 finds high-confidence matches (>0.7), use those directly
 * 4. Otherwise, fall back to semantic search via Qdrant
 * 5. Combine results using hybrid scoring
 *
 * This ensures deterministic matching for common patterns while preserving
 * semantic search for edge cases.
 */
export async function searchAvailableTools(
	input: SearchAvailableToolsInput,
): Promise<SearchAvailableToolsOutput> {
	const startTime = Date.now();
	console.log(`[SearchTools] Searching for: "${input.query}"`);
	const serverDetectionQuery = input.originalQuery || input.query;

	// ==========================================================================
	// STEP 1: Check always-available capabilities FIRST
	// These are high-frequency tools that should always be considered
	// Following Anthropic's recommendation to keep 3-5 tools non-deferred
	// ==========================================================================
	const alwaysAvailableMatches = matchAlwaysAvailableCapabilities(
		input.query,
	);

	if (alwaysAvailableMatches.length > 0) {
		console.log(
			`[SearchTools] Always-available matches: ${alwaysAvailableMatches.map((m) => `${m.name}(${(m.confidence * 100).toFixed(0)}%)`).join(", ")}`,
		);
	}

	// ==========================================================================
	// STEP 2: MCP Server Selection (Semantic + Regex Fallback)
	// Phase 1: Semantic similarity search in Qdrant (primary method)
	// Fallback: Regex pattern matching (for explicit "use X" patterns)
	// ==========================================================================
	const availableServerNames = await getAvailableServerNames(
		input.userId,
		input.organizationId,
		input.enabledMcpConfigIds,
	);

	// Try semantic server selection first (Phase 1)
	const semanticResult = await findRelevantServersBySemantic(
		input.query,
		input.userId,
		input.organizationId,
		{
			minScore: 0.7, // High confidence threshold
			limit: 3,
		},
	);

	let matchedServers: string[] = [];
	let isExplicitRequest = false;

	// Use semantic results if high confidence
	// NOTE: We don't set isExplicitRequest=true for semantic matches because
	// the semantic result might be an OAuth server (Teams/GitHub) which isn't
	// handled by fetchToolsFromExplicitServers (MCP-only). Instead, we just
	// use matchedServers as a hint for filtering in the broader tool search.
	if (
		semanticResult.isHighConfidence &&
		semanticResult.serverNames.length > 0
	) {
		matchedServers = semanticResult.serverNames;
		console.log(
			`[SearchTools] Semantic server selection (confidence=${(semanticResult.scores[0] * 100).toFixed(0)}%): ${matchedServers.join(", ")}`,
		);
	} else {
		// Fallback to regex-based detection for explicit patterns like "use crm"
		const regexResult = detectExplicitServerMention(
			serverDetectionQuery,
			availableServerNames,
		);
		matchedServers = regexResult.matchedServers;
		isExplicitRequest = regexResult.isExplicitRequest;

		if (matchedServers.length > 0) {
			console.log(
				`[SearchTools] Regex fallback detected server(s): ${matchedServers.join(", ")} (explicit=${isExplicitRequest})`,
			);
		} else if (semanticResult.serverNames.length > 0) {
			// Use semantic results even if below high confidence threshold
			matchedServers = semanticResult.serverNames;
			console.log(
				`[SearchTools] Using low-confidence semantic results: ${matchedServers.join(", ")} (score=${(semanticResult.scores[0] * 100).toFixed(0)}%)`,
			);
		}
	}

	// If user explicitly requested specific servers, fetch tools ONLY from those servers
	if (isExplicitRequest && matchedServers.length > 0) {
		const explicitResult = await fetchToolsFromExplicitServers(
			input.userId,
			input.organizationId,
			matchedServers,
			input.enabledMcpConfigIds,
			startTime,
		);
		if (explicitResult) {
			// Important: when the user explicitly asks for a specific MCP server,
			// do NOT reintroduce generic Fabric tools like web search. That weakens
			// the contract and allows unrelated tools to outrank the requested server.
			return {
				...explicitResult,
				telemetry: {
					strategy: "explicit_server",
					matchedServers,
					explicitServerUsed: true,
					keywordShortcutUsed: false,
				},
			};
		}
		console.warn(
			"[SearchTools] Explicit server fetch failed; returning no generic fallback for explicit server request",
		);
		return {
			results: [],
			totalToolsSearched: 0,
			semanticSearchUsed: false,
			durationMs: Date.now() - startTime,
			telemetry: {
				strategy: "explicit_server",
				matchedServers,
				explicitServerUsed: true,
				keywordShortcutUsed: false,
			},
		};
	}

	// ==========================================================================
	// STEP 3: BM25 Keyword Search (BEFORE semantic search)
	// Check KEYWORDS sections in tool descriptions for deterministic matching
	// ==========================================================================
	const allFabricAiTools = getFabricAiTools();
	// Filter Fabric AI tools by enabled list if provided
	const fabricAiTools = Array.isArray(input.enabledFabricToolIds)
		? allFabricAiTools.filter((tool) =>
				(input.enabledFabricToolIds as string[]).includes(tool.name),
			)
		: allFabricAiTools;
	const toolCapabilities: CapabilityWithKeywords[] = fabricAiTools.map(
		(tool) =>
			toolToCapabilityWithKeywords({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				configId: "fabric-ai-server",
				serverName: "Fabric AI",
			}),
	);

	const keywordMatches = searchByKeywords(toolCapabilities, {
		userMessage: input.query,
		type: "mcp_tool",
		limit: input.limit || 10,
		minConfidence: 0.5, // Require reasonable confidence for keyword matches
	});

	// If we have high-confidence keyword matches (>0.7), use them directly
	// This implements Anthropic's BM25-first pattern
	const highConfidenceKeywordMatches = keywordMatches.filter(
		(m) => m.confidence >= 0.7,
	);

	if (highConfidenceKeywordMatches.length > 0) {
		console.log(
			`[SearchTools] High-confidence KEYWORD matches found, skipping semantic search: ${highConfidenceKeywordMatches.map((m) => `${m.name}(${(m.confidence * 100).toFixed(0)}%)`).join(", ")}`,
		);

		const durationMs = Date.now() - startTime;
		const results = convertKeywordMatchesToResults(
			highConfidenceKeywordMatches,
			fabricAiTools,
		);

		// Merge with always-available matches
		const mergedResults = mergeResults(
			results,
			alwaysAvailableMatches,
			fabricAiTools,
		);

		return {
			results: mergedResults,
			totalToolsSearched: fabricAiTools.length,
			semanticSearchUsed: false,
			durationMs,
			telemetry: {
				strategy: "fabric_keyword_shortcut",
				matchedServers,
				explicitServerUsed: false,
				keywordShortcutUsed: true,
			},
		};
	}

	// ==========================================================================
	// STEP 4: Semantic Search (fallback when keyword search doesn't find matches)
	// ==========================================================================
	await ensureToolIndexBuilt(
		input.userId,
		input.organizationId,
		input.enabledMcpConfigIds,
		input.enabledIntegrationIds,
		input.enabledFabricToolIds,
	);

	// Now that the index is rebuilt for the current tenant, add OAuth tools
	// to the keyword corpus so the general fallback (STEP 5b) can find them.
	// Filter by enabledIntegrationIds to respect disabled integrations.
	const enabledIntegrationSet = Array.isArray(input.enabledIntegrationIds)
		? new Set(input.enabledIntegrationIds)
		: null;
	const integrationsExplicitlyDisabled =
		enabledIntegrationSet !== null && enabledIntegrationSet.size === 0;

	if (!integrationsExplicitlyDisabled) {
		const fabricToolNames = new Set(fabricAiTools.map((t) => t.name));
		const indexedEntries = toolIndex.getAllEntries();
		const oauthToolCapabilities: CapabilityWithKeywords[] = indexedEntries
			.filter((entry) => {
				if (!entry.configId?.startsWith("oauth:integration:")) {
					return false;
				}
				if (fabricToolNames.has(entry.toolName)) {
					return false;
				}
				// Apply enabledIntegrationIds filter if provided
				if (enabledIntegrationSet !== null) {
					const integrationId = entry.configId.replace(
						"oauth:integration:",
						"",
					);
					return enabledIntegrationSet.has(integrationId);
				}
				return true; // No filter = include all OAuth tools
			})
			.map((entry) =>
				toolToCapabilityWithKeywords({
					name: entry.toolName,
					description: entry.description,
					inputSchema: entry.inputSchema,
					configId: entry.configId,
					serverName: entry.serverName,
				}),
			);

		if (oauthToolCapabilities.length > 0) {
			toolCapabilities.push(...oauthToolCapabilities);
			console.log(
				`[SearchTools] Added ${oauthToolCapabilities.length} OAuth tools to keyword fallback corpus (total: ${toolCapabilities.length})`,
			);
		}
	}

	const stats = toolIndex.getStats();
	const corpusKeywordResults = await toolIndex.search({
		query: input.query,
		category: input.category,
		limit: input.limit || 10,
		minConfidence: 0.7,
		readOnlyOnly: input.readOnlyOnly,
		enabledMcpConfigIds: input.enabledMcpConfigIds,
		enabledIntegrationIds: input.enabledIntegrationIds,
		enabledFabricToolIds: input.enabledFabricToolIds,
	});

	if (corpusKeywordResults.length > 0) {
		console.log(
			`[SearchTools] Indexed keyword matches found, skipping semantic search: ${corpusKeywordResults.map((r) => `${r.tool.toolName}(${(r.confidence * 100).toFixed(0)}%)`).join(", ")}`,
		);

		const mergedKeywordResults = mergeResults(
			convertIndexedResultsToOutput(corpusKeywordResults),
			alwaysAvailableMatches,
			fabricAiTools,
		);

		return {
			results: mergedKeywordResults,
			totalToolsSearched: stats.totalTools,
			semanticSearchUsed: false,
			durationMs: Date.now() - startTime,
			telemetry: {
				strategy: "indexed_keyword_shortcut",
				matchedServers,
				explicitServerUsed: false,
				keywordShortcutUsed: true,
			},
		};
	}

	let results: ToolSearchResult[];
	let semanticSearchUsed = true;

	try {
		const tenantContext: TenantContext = {
			userId: input.userId,
			organizationId: input.organizationId,
		};

		results = await toolIndex.search(
			{
				query: input.query,
				category: input.category,
				limit: input.limit || 10,
				minConfidence: input.minConfidence || 0.2,
				readOnlyOnly: input.readOnlyOnly,
				userId: input.userId,
				organizationId: input.organizationId,
				includeSystem: true,
				enabledMcpConfigIds: input.enabledMcpConfigIds,
				enabledIntegrationIds: input.enabledIntegrationIds,
				enabledFabricToolIds: input.enabledFabricToolIds,
			},
			tenantContext,
		);
	} catch (error) {
		console.warn(
			"[SearchTools] Semantic search failed, falling back to keyword search:",
			error,
		);
		results = await toolIndex.search({
			query: input.query,
			category: input.category,
			limit: input.limit || 10,
			minConfidence: input.minConfidence || 0.2,
			readOnlyOnly: input.readOnlyOnly,
			enabledMcpConfigIds: input.enabledMcpConfigIds,
			enabledIntegrationIds: input.enabledIntegrationIds,
			enabledFabricToolIds: input.enabledFabricToolIds,
		});
		semanticSearchUsed = false;
	}

	// Handle implicit server mentions (boost tools from mentioned servers)
	if (matchedServers.length > 0) {
		// FALLBACK: If semantic search returned 0 results but a server was mentioned,
		// fetch tools directly from that server. This handles cases where:
		// 1. The tool embeddings don't semantically match the query well
		// 2. The minConfidence threshold filtered out all results
		// 3. The server's tools aren't indexed in Qdrant yet
		if (results.length === 0) {
			console.log(
				`[SearchTools] Semantic search returned 0 results for mentioned server(s): ${matchedServers.join(", ")}. Fetching tools directly.`,
			);
			const fallbackResult = await fetchToolsFromExplicitServers(
				input.userId,
				input.organizationId,
				matchedServers,
				input.enabledMcpConfigIds,
				startTime,
			);
			if (fallbackResult && fallbackResult.results.length > 0) {
				console.log(
					`[SearchTools] Fallback fetch found ${fallbackResult.results.length} tools from mentioned servers`,
				);
				return {
					...fallbackResult,
					telemetry: {
						strategy: "mentioned_server_fallback",
						matchedServers,
						explicitServerUsed: false,
						keywordShortcutUsed: false,
					},
				};
			}
		} else {
			// Server was mentioned and we have results - boost tools from mentioned servers
			results = results.map((r) => {
				const isFromMentionedServer = matchedServers.some(
					(server) =>
						r.tool.serverName.toLowerCase() ===
							server.toLowerCase() ||
						r.tool.serverName.toLowerCase().includes(
							server
								.toLowerCase()
								.replace(/\s*(mcp|server|api|service)$/i, "")
								.trim(),
						),
				);
				if (isFromMentionedServer) {
					return {
						...r,
						confidence: Math.min(r.confidence + 0.2, 1), // Boost by 20%
						matchReason: `Server mentioned in query: ${r.tool.serverName}. ${r.matchReason}`,
					};
				}
				return r;
			});
			// Re-sort by confidence after boosting
			results.sort((a, b) => b.confidence - a.confidence);
		}
	}

	// ==========================================================================
	// STEP 5b: Keyword fallback when semantic search returns 0 results
	// ==========================================================================
	if (results.length === 0) {
		// When the agent has specific MCP servers configured (focused agent),
		// fetch ALL tools from those servers directly. Semantic search may fail
		// for domain-specific tools whose descriptions don't match query wording.
		// The user explicitly chose these servers, so they must always be available.
		if (
			Array.isArray(input.enabledMcpConfigIds) &&
			input.enabledMcpConfigIds.length > 0
		) {
			console.log(
				`[SearchTools] Semantic search returned 0 results for focused agent (${input.enabledMcpConfigIds.length} config(s)). Fetching all tools from configured servers directly.`,
			);
			const focusedTools = await fetchToolsFromServerIds(
				input.enabledMcpConfigIds,
				input.userId,
				input.organizationId,
			);
			if (focusedTools.length > 0) {
				console.log(
					`[SearchTools] Focused fallback found ${focusedTools.length} tools from configured servers: ${[...new Set(focusedTools.map((t) => t.serverName))].join(", ")}`,
				);
				return {
					results: focusedTools.map((t) => ({
						toolId: `${t.configId}:${t.toolName}`,
						serverName: t.serverName,
						toolName: t.toolName,
						description: t.description,
						confidence: 0.8, // High confidence — user explicitly configured this server
						matchReason:
							"Tool from agent-configured MCP server (direct fetch)",
						category: t.category,
						configId: t.configId,
						riskLevel: t.riskLevel,
						isReadOnly: t.isReadOnly,
						inputSchema: t.inputSchema,
					})),
					totalToolsSearched: focusedTools.length,
					semanticSearchUsed: false,
					durationMs: Date.now() - startTime,
					telemetry: {
						strategy: "focused_server_fallback",
						matchedServers,
						explicitServerUsed: false,
						keywordShortcutUsed: false,
					},
				};
			}
		}

		// When the agent has OAuth integrations configured, fetch their tools from Qdrant.
		// Same rationale: the user explicitly connected these integrations, they must always work.
		if (
			Array.isArray(input.enabledIntegrationIds) &&
			input.enabledIntegrationIds.length > 0
		) {
			console.log(
				`[SearchTools] Semantic search returned 0 results for agent with ${input.enabledIntegrationIds.length} OAuth integration(s). Fetching integration tools from Qdrant.`,
			);
			const integrationToolResults: SearchAvailableToolsOutput["results"] =
				[];
			for (const integrationId of input.enabledIntegrationIds) {
				const configId = `oauth:integration:${integrationId}`;
				try {
					const capabilities = await getCapabilitiesByTenant(
						input.userId,
						input.organizationId,
						"mcp_tool",
						100,
						{ configId },
					);
					for (const cap of capabilities) {
						const meta = cap.capability.metadata;
						integrationToolResults.push({
							toolId: `${configId}:${cap.capability.name}`,
							serverName:
								(meta.serverName as string) ||
								"OAuth Integration",
							toolName: cap.capability.name,
							description: cap.capability.description,
							confidence: 0.8,
							matchReason:
								"Tool from agent-configured OAuth integration (direct fetch)",
							category: meta.category as ToolCategory | undefined,
							configId,
							riskLevel:
								(meta.riskLevel as
									| "low"
									| "medium"
									| "high"
									| "critical") || "low",
							isReadOnly: (meta.isReadOnly as boolean) ?? true,
							inputSchema: meta.inputSchema as
								| Record<string, unknown>
								| undefined,
						});
					}
				} catch (err) {
					console.warn(
						`[SearchTools] Failed to fetch tools for integration ${integrationId}:`,
						err,
					);
				}
			}
			if (integrationToolResults.length > 0) {
				console.log(
					`[SearchTools] OAuth integration fallback found ${integrationToolResults.length} tools`,
				);
				return {
					results: integrationToolResults,
					totalToolsSearched: integrationToolResults.length,
					semanticSearchUsed: false,
					durationMs: Date.now() - startTime,
					telemetry: {
						strategy: "focused_server_fallback",
						matchedServers,
						explicitServerUsed: false,
						keywordShortcutUsed: false,
					},
				};
			}
		}

		// General fallback: Re-run BM25 with a lower threshold as a last resort
		const fallbackKeywordMatches = searchByKeywords(toolCapabilities, {
			userMessage: input.query,
			type: "mcp_tool",
			limit: input.limit || 10,
			minConfidence: 0.1, // Lower threshold - last resort when semantic fails
		});
		if (fallbackKeywordMatches.length > 0) {
			console.log(
				`[SearchTools] Semantic search returned 0 results, falling back to ${fallbackKeywordMatches.length} low-confidence keyword matches: ${fallbackKeywordMatches.map((m) => `${m.name}(${(m.confidence * 100).toFixed(0)}%)`).join(", ")}`,
			);
			const keywordResults = convertKeywordMatchesToResults(
				fallbackKeywordMatches,
				fabricAiTools,
			);
			const mergedKeywordResults = mergeResults(
				keywordResults,
				alwaysAvailableMatches,
				fabricAiTools,
			);
			return {
				results: mergedKeywordResults,
				totalToolsSearched: fabricAiTools.length,
				semanticSearchUsed: false,
				durationMs: Date.now() - startTime,
				telemetry: {
					strategy: "semantic_fallback_keyword",
					matchedServers,
					explicitServerUsed: false,
					keywordShortcutUsed: true,
				},
			};
		}
	}

	const durationMs = Date.now() - startTime;

	// Convert ToolSearchResult to output format
	const outputResults: SearchAvailableToolsOutput["results"] = results.map(
		(r) => ({
			toolId: r.tool.id,
			serverName: r.tool.serverName,
			toolName: r.tool.toolName,
			description: r.tool.description,
			confidence: r.confidence,
			matchReason: r.matchReason,
			category: r.tool.category,
			riskLevel: r.tool.riskLevel,
			isReadOnly: r.tool.isReadOnly,
			configId: r.tool.configId,
			inputSchema: r.tool.inputSchema,
		}),
	);

	// ==========================================================================
	// STEP 6: Merge with always-available matches
	// Ensures high-frequency tools like workspace_rag_query are always considered
	// ==========================================================================
	const mergedResults = mergeResults(
		outputResults,
		alwaysAvailableMatches,
		fabricAiTools,
	);

	console.log(
		`[SearchTools] Found ${mergedResults.length} tools in ${durationMs}ms (searched ${stats.totalTools} total, semantic: ${semanticSearchUsed}, always-available: ${alwaysAvailableMatches.length})`,
	);

	return {
		results: mergedResults,
		totalToolsSearched: stats.totalTools,
		semanticSearchUsed,
		durationMs,
		telemetry: {
			strategy: "semantic",
			matchedServers,
			explicitServerUsed: false,
			keywordShortcutUsed: false,
		},
	};
}

/**
 * Load full tool definitions for specific tools (on-demand loading).
 * Called after search to get the full schema for selected tools.
 */
export async function loadToolDefinitions(
	toolIds: string[],
	userId: string,
	organizationId?: string,
): Promise<
	Array<{
		toolId: string;
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
		configId: string;
	}>
> {
	console.log(
		`[SearchTools] Loading definitions for ${toolIds.length} tools`,
	);

	const definitions: Array<{
		toolId: string;
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
		configId: string;
	}> = [];

	// Get entries from index
	for (const toolId of toolIds) {
		const entry = toolIndex.getEntry(toolId);
		if (!entry) {
			continue;
		}

		// If we already have the schema cached, use it
		if (entry.inputSchema) {
			definitions.push({
				toolId: entry.id,
				name: entry.toolName,
				description: entry.description,
				inputSchema: entry.inputSchema,
				configId: entry.configId,
			});
			continue;
		}

		// Otherwise, fetch from MCP server
		try {
			const result = await getMcpClient(
				entry.configId,
				userId,
				organizationId,
			);
			if (!result) {
				continue;
			}

			const { client } = result;
			const tools = await client.tools();
			const tool = tools[entry.toolName] as {
				description?: string;
				inputSchema?: Record<string, unknown>;
			};

			if (tool) {
				definitions.push({
					toolId: entry.id,
					name: entry.toolName,
					description: tool.description || entry.description,
					inputSchema: tool.inputSchema || {},
					configId: entry.configId,
				});
			}

			await closeMcpClientSafe(client);
		} catch (error) {
			console.warn(
				`[SearchTools] Failed to load definition for ${toolId}:`,
				error,
			);
		}
	}

	return definitions;
}
