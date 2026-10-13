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

import { readMcpToolAnnotations } from "@repo/utils/mcp-tool-annotations";
import { boundProjectId, projectBoundTools } from "./project-binding";
import {
	PLATFORM_SERVER_NAME,
	selectionAllowsTool,
	selectionIncludesServer,
	selectionRefusalMessage,
	unknownServerNames,
	unknownServerNamesMessage,
	unknownToolNamesMessage,
} from "./server-selection";
import type {
	ConnectedServerInfo,
	GatewaySession,
	GatewayToolDefinition,
	ServerSelection,
	ToolAnnotations,
	ToolCallResult,
} from "./types";

/** Who a tool list is for: the person and the organization it is cached under. */
type ToolListOwner = Pick<GatewaySession, "userId" | "organizationId">;

/**
 * Cache TTL for tool aggregation (5 minutes): how long an aggregated list is
 * reused. A rebuild reads each connection's stored tool schemas, which have
 * their own longer lifetime, so this does not bound how old a schema can be.
 * Which prefix reaches which connection is checked on every read instead
 * (`routingFingerprint` in `getFullToolList`).
 */
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory cache for aggregated tool lists per user+org.
 *
 * It holds the full list only. A session's server selection is applied to what
 * is read from it (`applyServerSelection` in `getAggregatedTools`), never before
 * it is written, so two clients of the same person with different selections
 * share one entry and cannot be served each other's narrowed list.
 *
 * `routingFingerprint` is the prefix-to-connection mapping of the connection
 * rows the entry was built from. `getFullToolList` compares it with the
 * current rows on every read and rebuilds on a difference, so a rename, add,
 * removal, enable or disable that changes which prefix names which connection
 * shows up on the next request rather than after the TTL. A change that leaves
 * every prefix the same, such as a rename that differs only in letter case,
 * keeps the old display names and descriptions until the TTL.
 */
const toolListCache = new Map<
	string,
	{
		tools: GatewayToolDefinition[];
		servers: ConnectedServerInfo[];
		routingFingerprint: string;
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
 * Get the aggregated tools for a user session: the platform tools and the
 * connected servers' tools, narrowed to the session's server selection
 * (`GatewaySession.serverSelection`) by `selectionAllowsTool`. The returned
 * `servers` keep only the servers the selection names, so a deselected
 * server's prefix resolves to nothing for a caller that executes through them.
 */
export async function getAggregatedTools(
	session: GatewaySession,
): Promise<{ tools: GatewayToolDefinition[]; servers: ConnectedServerInfo[] }> {
	// A session bound to one project is offered that project's platform tools
	// and no connected server's: those belong to the person and the
	// organization, with no tie to a project. It never reaches the discovery
	// below, and so never reads or fills the shared cache.
	if (boundProjectId(session) !== null) {
		const { PLATFORM_TOOL_DEFINITIONS } = await import("./platform-tools");
		return {
			tools: projectBoundTools(PLATFORM_TOOL_DEFINITIONS),
			servers: [],
		};
	}

	return applyServerSelection(await getFullToolList(session), session);
}

/**
 * Every platform tool and every discoverable connected server's tools for this
 * person and organization, from the shared cache or freshly discovered. The
 * cache is read and written only here, with the full list, never a selection's.
 */
async function getFullToolList(
	owner: ToolListOwner,
): Promise<{ tools: GatewayToolDefinition[]; servers: ConnectedServerInfo[] }> {
	const cacheKey = getCacheKey(owner.userId, owner.organizationId);
	const cached = toolListCache.get(cacheKey);

	if (cached && Date.now() - cached.cachedAt < TOOL_CACHE_TTL_MS) {
		// Within the TTL the entry is used only while the connections still
		// map the same prefixes to the same ids. A failure of this query
		// propagates; it does not fall back to the entry.
		const { listMcpConfigRoutingForTenant } = await import(
			"@repo/database"
		);
		const current = await listMcpConfigRoutingForTenant({
			userId: owner.userId,
			organizationId: owner.organizationId,
		});
		if (
			fingerprintServerPrefixes(assignServerPrefixes(current)) ===
			cached.routingFingerprint
		) {
			return { tools: cached.tools, servers: cached.servers };
		}
	}

	// Build fresh tool list
	const { PLATFORM_TOOL_DEFINITIONS } = await import("./platform-tools");
	const { servers: connectedServers, routingFingerprint } =
		await discoverConnectedServerTools(owner);

	// Build namespaced tools from connected servers
	const connectedTools: GatewayToolDefinition[] = [];
	for (const server of connectedServers) {
		for (const tool of server.tools) {
			const annotations = readMcpToolAnnotations(tool.annotations);
			connectedTools.push({
				name: `${server.toolPrefix}__${tool.name}`,
				description: `[${server.displayName}] ${tool.description || tool.name}`,
				inputSchema: tool.inputSchema || {
					type: "object",
					properties: {},
				},
				_gateway_source: server.displayName,
				_gateway_config_id: server.configId,
				...(annotations ? { annotations } : {}),
			});
		}
	}

	const allTools = [...PLATFORM_TOOL_DEFINITIONS, ...connectedTools];

	// Cache the full result; a selection is applied after, on the way out.
	toolListCache.set(cacheKey, {
		tools: allTools,
		servers: connectedServers,
		routingFingerprint,
		cachedAt: Date.now(),
	});

	return { tools: allTools, servers: connectedServers };
}

/**
 * Narrow a full tool list to the session's server selection. A session without
 * one gets the list as it is; otherwise the result is new arrays built with
 * `filter`, which leaves the ones passed in, which may be the cache's,
 * untouched.
 */
function applyServerSelection(
	full: { tools: GatewayToolDefinition[]; servers: ConnectedServerInfo[] },
	session: GatewaySession,
): { tools: GatewayToolDefinition[]; servers: ConnectedServerInfo[] } {
	if ((session.serverSelection ?? null) === null) {
		return full;
	}
	return {
		tools: full.tools.filter((tool) =>
			selectionAllowsTool(session, tool.name),
		),
		servers: full.servers.filter((server) =>
			selectionIncludesServer(session, server.toolPrefix),
		),
	};
}

/**
 * The tool prefix of each of the caller's enabled connected servers, as
 * `getAggregatedTools` names their tools — the names a server selection may
 * use besides `fabric`. Read from the connection records only: a server whose
 * tools cannot be discovered right now still has its name.
 */
async function listConnectedServerPrefixes(
	owner: ToolListOwner,
): Promise<string[]> {
	const { listMcpConfigRoutingForTenant } = await import("@repo/database");
	const configs = await listMcpConfigRoutingForTenant({
		userId: owner.userId,
		organizationId: owner.organizationId,
	});
	return assignServerPrefixes(configs).map(({ prefix }) => prefix);
}

/**
 * Whether a parsed selection names only servers and tools this person has in
 * this organization; asked when a session is created with one.
 *
 * - A server must be `fabric` or the prefix of an enabled connection. Checked
 *   against the connection records, so a server that cannot be reached still
 *   counts.
 * - A `fabric` tool must be a platform tool definition.
 * - A connected server's tool is checked against that server's tools when they
 *   can be discovered (the same full list `tools/list` is built from). When the
 *   server is missing from that list — unreachable, timed out, or offering no
 *   tools right now — its tool entries are accepted, so an outage does not fail
 *   the connection; a tool it turns out not to have is then simply not listed.
 *   The list is the same cached mapping from prefix to connection that
 *   `tools/list` and `tools/call` route through, so a `server:tool` entry is
 *   judged by exactly what a later call would reach. `getFullToolList` reuses
 *   a cached list only after its stored prefix-to-connection fingerprint
 *   equals one computed from the connections as they are at that read (Fizzy
 *   #3024), so a rename, add or removal that changes which prefix names which
 *   connection is seen on the next call. A change
 *   made after that check, while the request is still running, is not
 *   covered. The selection narrows what the client sees and grants nothing,
 *   so a stale verdict cannot widen anyone's access.
 *
 * Every problem found is reported together, with the valid names.
 */
export async function validateServerSelection(
	owner: ToolListOwner,
	selection: ServerSelection,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const prefixes = await listConnectedServerPrefixes(owner);
	const unknownServers = unknownServerNames(selection, prefixes);
	if (unknownServers.length > 0) {
		return {
			ok: false,
			message: unknownServerNamesMessage(unknownServers, prefixes),
		};
	}

	const problems: string[] = [];
	const platform = selection.find(
		(entry) => entry.server === PLATFORM_SERVER_NAME,
	);
	if (platform && platform.tools !== "*") {
		const { PLATFORM_TOOL_DEFINITIONS } = await import("./platform-tools");
		const valid = PLATFORM_TOOL_DEFINITIONS.map((tool) => tool.name);
		const unknown = platform.tools.filter((tool) => !valid.includes(tool));
		if (unknown.length > 0) {
			problems.push(
				unknownToolNamesMessage(PLATFORM_SERVER_NAME, unknown, valid),
			);
		}
	}

	const connected = selection.filter(
		(entry) => entry.server !== PLATFORM_SERVER_NAME && entry.tools !== "*",
	);
	if (connected.length > 0) {
		const { servers } = await getFullToolList(owner);
		for (const entry of connected) {
			const server = servers.find((s) => s.toolPrefix === entry.server);
			if (!server || entry.tools === "*") {
				continue;
			}
			const valid = server.tools.map((tool) => tool.name);
			const unknown = entry.tools.filter((tool) => !valid.includes(tool));
			if (unknown.length > 0) {
				problems.push(
					unknownToolNamesMessage(entry.server, unknown, valid),
				);
			}
		}
	}

	return problems.length > 0
		? { ok: false, message: problems.join(" ") }
		: { ok: true };
}

/**
 * Name each enabled connection's tool prefix, in the order given, appending a
 * counter to a prefix already taken (`github`, `github_2`). The one place
 * prefixes are assigned, so the names a selection is checked against and the
 * names the tools are listed under cannot drift apart.
 *
 * `fabric` starts out taken: it is the platform tools' name in a server
 * selection, so a connection named "Fabric" gets `fabric_2`.
 */
function assignServerPrefixes<
	Config extends {
		enabled: boolean;
		displayName?: string | null;
		mcpServer?: { name?: string | null } | null;
	},
>(
	configs: Config[],
): Array<{ config: Config; serverName: string; prefix: string }> {
	const assigned: Array<{
		config: Config;
		serverName: string;
		prefix: string;
	}> = [];
	// Track used prefixes to avoid collisions
	const usedPrefixes = new Set<string>([PLATFORM_SERVER_NAME]);

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
		assigned.push({ config, serverName, prefix });
	}

	return assigned;
}

/**
 * The prefix-to-connection mapping as a string that is equal for two sets of
 * connection rows exactly when they assign the same prefix to the same
 * connection id. Built from `assignServerPrefixes` output, so it follows the
 * same enabled filter, naming and collision rules as the tool list.
 */
function fingerprintServerPrefixes(
	assigned: Array<{ config: { id: string }; prefix: string }>,
): string {
	return assigned
		.map(({ config, prefix }) => `${prefix}=${config.id}`)
		.join("|");
}

/**
 * Discover tools from all connected MCP servers for this tenant.
 * Uses cached tool schemas from MCPConfig for performance.
 *
 * Also returns the fingerprint of the connection rows loaded here, which is
 * the one the cache entry is stored with, so a rename that lands while this
 * runs differs from it on the next read.
 */
async function discoverConnectedServerTools(
	session: ToolListOwner,
): Promise<{ servers: ConnectedServerInfo[]; routingFingerprint: string }> {
	const { listMcpConfigsForTenant } = await import("@repo/database");

	const configs = await listMcpConfigsForTenant({
		userId: session.userId,
		organizationId: session.organizationId,
	});

	const servers: ConnectedServerInfo[] = [];
	const assigned = assignServerPrefixes(configs);

	for (const { config, serverName, prefix } of assigned) {
		// Use cached tools if available and not stale (24 hour TTL for cache)
		const cachedTools = config.cachedTools as Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, unknown>;
			annotations?: ToolAnnotations;
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

	return {
		servers,
		routingFingerprint: fingerprintServerPrefixes(assigned),
	};
}

/**
 * Live tool discovery from an MCP server.
 * Uses getCachedMcpClientForConfig for connection reuse.
 * Has a 10-second timeout to avoid blocking the tools/list response.
 */
async function discoverToolsLive(
	configId: string,
	session: ToolListOwner,
): Promise<
	Array<{
		name: string;
		description?: string;
		inputSchema?: Record<string, unknown>;
		annotations?: ToolAnnotations;
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
			// Only lists the server's tools.
			access: "read",
		});

		const toolsMap = await client.tools();
		const tools: Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, unknown>;
			annotations?: ToolAnnotations;
		}> = [];

		for (const [name, tool] of Object.entries(toolsMap)) {
			const t = tool as {
				description?: string;
				inputSchema?: unknown;
				metadata?: { annotations?: unknown };
			};
			tools.push({
				name,
				description: t.description,
				inputSchema: normalizeInputSchema(t.inputSchema),
				annotations: readMcpToolAnnotations(t.metadata?.annotations),
			});
		}

		// Update cache in the background
		updateMcpConfigToolCache({
			configId,
			tools: tools.map((t) => ({
				name: t.name,
				description: t.description ?? null,
				inputSchema: t.inputSchema ?? null,
				annotations: t.annotations ?? null,
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
	// Never on a session bound to one project, whatever reached this far: a
	// connected server is the person's and the organization's, and has no
	// project to be held to.
	if (boundProjectId(session) !== null) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: "Connected server tools are not available on a connection to one project.",
					}),
				},
			],
			isError: true,
		};
	}

	// Nor a tool the session's selection leaves out, checked here as well as
	// in the gateway's tools/call routing so no caller of this function can
	// reach a deselected tool's upstream.
	if (!selectionAllowsTool(session, namespacedToolName)) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: selectionRefusalMessage(namespacedToolName),
					}),
				},
			],
			isError: true,
		};
	}

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
			// Executes a tool.
			access: "connect" as const,
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
			"[MCP Gateway] Connected tool error:",
			{ namespacedToolName },
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
