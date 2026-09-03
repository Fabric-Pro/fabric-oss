/**
 * Fabric MCP Gateway - Tool Aggregator
 *
 * Dynamically aggregates tools from:
 * 1. Fabric platform tools (projects, docs, workspaces, workflows, etc.)
 * 2. User's connected MCP server tools (from MCPConfig entries)
 *
 * Connected server tools are namespaced with a server prefix to avoid
 * collisions (e.g., "linear__list_issues", "github__list_repos").
 *
 * Uses MCPConfig.cachedTools for fast listing without connecting to
 * every upstream server. Falls back to live tool discovery if cache is stale.
 */

import type {
	ConnectedServerInfo,
	GatewaySession,
	GatewayToolDefinition,
	ToolCallResult,
} from "./types";

/** Cache TTL for tool aggregation (5 minutes) */
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

/** In-memory cache for aggregated tool lists per user+org */
const toolListCache = new Map<
	string,
	{
		tools: GatewayToolDefinition[];
		servers: ConnectedServerInfo[];
		cachedAt: number;
	}
>();

function getCacheKey(userId: string, organizationId: string | null): string {
	return `${userId}:${organizationId ?? "personal"}`;
}

/**
 * Sanitize a server name into a valid tool name prefix.
 * Converts to lowercase, replaces non-alphanumeric chars with underscores.
 */
function sanitizePrefix(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 30);
}

/**
 * Get all aggregated tools for a user session.
 * Returns both platform tools and connected server tools.
 */
export async function getAggregatedTools(
	session: GatewaySession,
): Promise<{ tools: GatewayToolDefinition[]; servers: ConnectedServerInfo[] }> {
	const cacheKey = getCacheKey(session.userId, session.organizationId);
	const cached = toolListCache.get(cacheKey);

	if (cached && Date.now() - cached.cachedAt < TOOL_CACHE_TTL_MS) {
		return { tools: cached.tools, servers: cached.servers };
	}

	// Build fresh tool list
	const { PLATFORM_TOOL_DEFINITIONS } = await import("./platform-tools");
	const connectedServers = await discoverConnectedServerTools(session);

	// Build namespaced tools from connected servers
	const connectedTools: GatewayToolDefinition[] = [];
	for (const server of connectedServers) {
		for (const tool of server.tools) {
			connectedTools.push({
				name: `${server.toolPrefix}__${tool.name}`,
				description: `[${server.displayName}] ${tool.description || tool.name}`,
				inputSchema: tool.inputSchema || {
					type: "object",
					properties: {},
				},
				_gateway_source: server.displayName,
				_gateway_config_id: server.configId,
			});
		}
	}

	const allTools = [...PLATFORM_TOOL_DEFINITIONS, ...connectedTools];

	// Cache the result
	toolListCache.set(cacheKey, {
		tools: allTools,
		servers: connectedServers,
		cachedAt: Date.now(),
	});

	return { tools: allTools, servers: connectedServers };
}

/**
 * Discover tools from all connected MCP servers for this tenant.
 * Uses cached tool schemas from MCPConfig for performance.
 */
async function discoverConnectedServerTools(
	session: GatewaySession,
): Promise<ConnectedServerInfo[]> {
	const { listMcpConfigsForTenant } = await import("@repo/database");

	const configs = await listMcpConfigsForTenant({
		userId: session.userId,
		organizationId: session.organizationId,
	});

	const servers: ConnectedServerInfo[] = [];
	// Track used prefixes to avoid collisions
	const usedPrefixes = new Set<string>();

	for (const config of configs) {
		if (!config.enabled) {
			continue;
		}

		const serverName =
			config.displayName || config.mcpServer?.name || "unknown";
		let prefix = sanitizePrefix(serverName);

		// Handle duplicate prefixes by appending a counter
		if (usedPrefixes.has(prefix)) {
			let counter = 2;
			while (usedPrefixes.has(`${prefix}_${counter}`)) {
				counter++;
			}
			prefix = `${prefix}_${counter}`;
		}
		usedPrefixes.add(prefix);

		// Use cached tools if available and not stale (24 hour TTL for cache)
		const cachedTools = config.cachedTools as Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, unknown>;
		}> | null;

		const cacheAge = config.toolsCachedAt
			? Date.now() - new Date(config.toolsCachedAt).getTime()
			: Number.POSITIVE_INFINITY;
		const CACHE_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

		if (
			cachedTools &&
			Array.isArray(cachedTools) &&
			cachedTools.length > 0 &&
			cacheAge < CACHE_STALE_MS
		) {
			servers.push({
				configId: config.id,
				displayName: serverName,
				toolPrefix: prefix,
				tools: cachedTools,
			});
		} else {
			// Try live tool discovery (with timeout to avoid blocking)
			try {
				const liveTools = await discoverToolsLive(config.id, session);
				if (liveTools.length > 0) {
					servers.push({
						configId: config.id,
						displayName: serverName,
						toolPrefix: prefix,
						tools: liveTools,
					});
				}
			} catch (error) {
				// If live discovery fails, use whatever cached tools exist (even if stale)
				if (
					cachedTools &&
					Array.isArray(cachedTools) &&
					cachedTools.length > 0
				) {
					servers.push({
						configId: config.id,
						displayName: serverName,
						toolPrefix: prefix,
						tools: cachedTools,
					});
				}
				// Otherwise just skip this server — it's unreachable
				console.warn(
					`[MCP Gateway] Failed to discover tools for ${serverName}:`,
					error instanceof Error ? error.message : error,
				);
			}
		}
	}

	return servers;
}

/**
 * Live tool discovery from an MCP server.
 * Uses getCachedMcpClientForConfig for connection reuse.
 * Has a 10-second timeout to avoid blocking the tools/list response.
 */
async function discoverToolsLive(
	configId: string,
	session: GatewaySession,
): Promise<
	Array<{
		name: string;
		description?: string;
		inputSchema?: Record<string, unknown>;
	}>
> {
	const { getCachedMcpClientForConfig } = await import("@repo/mcp");
	const { updateMcpConfigToolCache } = await import("@repo/database");

	const DISCOVERY_TIMEOUT_MS = 10_000;

	const discoveryPromise = async () => {
		const siteUrl =
			process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001";
		const { client } = await getCachedMcpClientForConfig({
			configId,
			userId: session.userId,
			organizationId: session.organizationId || undefined,
			redirectUri: `${siteUrl}/api/mcp/oauth/callback`,
		});

		const toolsMap = await client.tools();
		const tools: Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, unknown>;
		}> = [];

		for (const [name, tool] of Object.entries(toolsMap)) {
			const t = tool as {
				description?: string;
				inputSchema?: unknown;
			};
			tools.push({
				name,
				description: t.description,
				inputSchema: normalizeInputSchema(t.inputSchema),
			});
		}

		// Update cache in the background
		updateMcpConfigToolCache({
			configId,
			tools: tools.map((t) => ({
				name: t.name,
				description: t.description ?? null,
				inputSchema: t.inputSchema ?? null,
			})),
		}).catch(() => {});

		return tools;
	};

	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new Error("Tool discovery timeout")),
			DISCOVERY_TIMEOUT_MS,
		);
	});

	return Promise.race([discoveryPromise(), timeoutPromise]);
}

/**
 * Execute a connected server tool.
 * Parses the namespaced tool name, finds the right config, and executes.
 */
export async function executeConnectedServerTool(
	namespacedToolName: string,
	args: Record<string, unknown>,
	session: GatewaySession,
	servers: ConnectedServerInfo[],
): Promise<ToolCallResult> {
	// Parse prefix__toolName
	const separatorIndex = namespacedToolName.indexOf("__");
	if (separatorIndex === -1) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: `Invalid tool name: ${namespacedToolName}`,
					}),
				},
			],
			isError: true,
		};
	}

	const prefix = namespacedToolName.slice(0, separatorIndex);
	const originalToolName = namespacedToolName.slice(separatorIndex + 2);

	// Find the server by prefix
	const server = servers.find((s) => s.toolPrefix === prefix);
	if (!server) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: `No connected server found for prefix "${prefix}"`,
					}),
				},
			],
			isError: true,
		};
	}

	// Execute via MCP client
	try {
		const { getCachedMcpClientForConfig, invalidateMcpClientCache } =
			await import("@repo/mcp");

		const siteUrl =
			process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001";
		const clientOpts = {
			configId: server.configId,
			userId: session.userId,
			organizationId: session.organizationId || undefined,
			redirectUri: `${siteUrl}/api/mcp/oauth/callback`,
		};

		let client: Awaited<
			ReturnType<typeof getCachedMcpClientForConfig>
		>["client"];
		let tools: Record<string, unknown>;

		try {
			const result = await getCachedMcpClientForConfig(clientOpts);
			client = result.client;
			tools = await client.tools();
		} catch {
			// Retry with fresh connection
			await invalidateMcpClientCache(
				server.configId,
				session.userId,
				session.organizationId || undefined,
			).catch(() => {});

			const retry = await getCachedMcpClientForConfig({
				...clientOpts,
				forceNew: true,
			});
			client = retry.client;
			tools = await retry.client.tools();
		}

		const tool = (
			tools as Record<
				string,
				{ execute?: (args: unknown, ctx: unknown) => Promise<unknown> }
			>
		)[originalToolName];
		if (!tool?.execute) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							error: `Tool "${originalToolName}" not found on ${server.displayName}`,
							availableTools: Object.keys(tools),
						}),
					},
				],
				isError: true,
			};
		}

		const result = await tool.execute(args, {
			toolCallId: `${namespacedToolName}-${Date.now()}`,
			messages: [],
		});

		return parseMcpToolResult(result);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Tool execution failed";
		console.error(
			"[MCP Gateway] Connected tool %s error:",
			namespacedToolName,
			error,
		);
		return {
			content: [
				{ type: "text", text: JSON.stringify({ error: message }) },
			],
			isError: true,
		};
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize MCP input schema - handles wrapped { jsonSchema: {...} } format.
 */
function normalizeInputSchema(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== "object") {
		return { type: "object", properties: {} };
	}

	const s = schema as Record<string, unknown>;
	if ("jsonSchema" in s && s.jsonSchema && typeof s.jsonSchema === "object") {
		return s.jsonSchema as Record<string, unknown>;
	}

	return s as Record<string, unknown>;
}

/**
 * Parse MCP tool result into gateway format.
 */
function parseMcpToolResult(result: unknown): ToolCallResult {
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const obj = result as Record<string, unknown>;

		if (obj.isError === true) {
			const textContent = Array.isArray(obj.content)
				? (obj.content as Array<{ type?: string; text?: string }>).find(
						(c) => c.type === "text",
					)
				: null;
			return {
				content: [
					{
						type: "text",
						text:
							(textContent?.text as string) ||
							"MCP tool returned an error",
					},
				],
				isError: true,
			};
		}

		if (Array.isArray(obj.content)) {
			const textContent = (
				obj.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textContent?.text) {
				return { content: [{ type: "text", text: textContent.text }] };
			}
		}
	}

	if (Array.isArray(result)) {
		const textContent = (
			result as Array<{ type?: string; text?: string }>
		).find((c) => c.type === "text");
		if (textContent?.text) {
			return { content: [{ type: "text", text: textContent.text }] };
		}
	}

	// Fallback: stringify the result
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
	};
}
