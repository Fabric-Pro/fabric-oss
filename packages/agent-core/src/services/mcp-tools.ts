/**
 * MCP Tools Utilities
 *
 * Shared utilities for MCP (Model Context Protocol) tool discovery and execution.
 * Used by both:
 * - Temporal Orchestrator mode (via activities)
 * - Direct mode (via API routes)
 *
 * Provides:
 * - MCP client creation with authentication
 * - Tool discovery and metadata extraction
 * - Task-to-tool matching with intent analysis
 */

import { db, listMcpConfigsForTenant } from "@repo/database";
import {
	closeMcpClient,
	createMcpClientForConfig,
	McpClientError,
	type McpClientType,
} from "@repo/mcp";

// ============================================================================
// Types
// ============================================================================

export interface DetailedMcpToolInfo {
	configId: string;
	configName: string;
	serverName: string;
	tools: Array<{
		name: string;
		description: string;
		inputSchema?: Record<string, unknown>;
	}>;
	/** Keywords for semantic matching (from tool names and descriptions) */
	serviceKeywords: string[];
}

export interface McpToolMatchResult {
	canHandle: boolean;
	confidence: number;
	matchedTools: Array<{
		configId: string;
		toolName: string;
		reason: string;
	}>;
	reasoning: string;
	isReadOnly: boolean;
}

export interface McpClientResult {
	client: McpClientType;
	serverName: string;
}

/**
 * Typed result for callers that need to distinguish WHY a client could not be
 * created (e.g. surfacing "credentials missing" vs "token expired" to a user).
 * `getMcpClient` intentionally collapses this to `null`; use this variant when
 * the failure reason matters.
 */
export type McpClientResultOrError =
	| { ok: true; client: McpClientType; serverName: string }
	| { ok: false; error: { code: string; message: string } };

export interface GetMcpToolsOptions {
	userId: string;
	organizationId?: string;
	/** Optional filter to specific config IDs */
	enabledMcpConfigIds?: string[] | null;
}

// ============================================================================
// MCP Client Management
// ============================================================================

/**
 * Create an MCP client for a specific configuration.
 * Uses createMcpClientForConfig from @repo/mcp - supports HTTP, SSE, and STDIO
 * (Azure DevOps via wrapper). Handles authentication (API key, OAuth) automatically.
 */
export async function getMcpClient(
	configId: string,
	userId: string,
	organizationId?: string,
): Promise<McpClientResult | null> {
	const result = await getMcpClientResult(configId, userId, organizationId);
	if (!result.ok) {
		console.warn("[getMcpClient] Failed to create client:", result.error);
		return null;
	}
	return { client: result.client, serverName: result.serverName };
}

/**
 * Like {@link getMcpClient} but preserves the typed failure reason instead of
 * collapsing every error to `null`. On failure returns the `McpClientError`
 * code (CONFIG_NOT_FOUND, CONFIG_DISABLED, OAUTH_AUTH_REQUIRED, AUTH_FAILED,
 * RATE_LIMIT, …) so callers can map it to a user-facing state.
 */
export async function getMcpClientResult(
	configId: string,
	userId: string,
	organizationId?: string,
): Promise<McpClientResultOrError> {
	try {
		const result = await createMcpClientForConfig({
			configId,
			userId,
			organizationId,
		});
		return {
			ok: true,
			client: result.client,
			serverName: result.serverName,
		};
	} catch (error) {
		if (error instanceof McpClientError) {
			return {
				ok: false,
				error: { code: error.code, message: error.message },
			};
		}
		return {
			ok: false,
			error: {
				code: "UNKNOWN",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

/**
 * Close an MCP client connection safely.
 */
export async function closeMcpClientSafe(client: McpClientType): Promise<void> {
	try {
		await closeMcpClient(client);
	} catch (error) {
		console.warn("[MCP] Error closing client:", error);
	}
}

/**
 * Get all MCP configurations for a tenant.
 *
 * SECURITY: Strict isolation between personal and organizational data.
 * When organizationId is provided, ONLY returns organization configs.
 * When organizationId is NOT provided, ONLY returns personal configs.
 */
export async function getTenantMcpConfigs(
	userId: string,
	organizationId?: string,
): Promise<
	Array<{
		id: string;
		displayName: string | null;
		enabled: boolean;
		baseUrl?: string | null;
		transport?: string | null;
		authType?: string | null;
		mcpServer?: { name: string; defaultUrl?: string | null } | null;
	}>
> {
	// Per-user-within-org pattern: each user has their own MCP configs
	// In org context: returns user's configs within that org
	// In personal context: returns user's personal configs only
	const configs = await listMcpConfigsForTenant({
		userId,
		organizationId,
	});
	return configs || [];
}

// ============================================================================
// Tool Discovery
// ============================================================================

/**
 * Fetches detailed MCP tool information including descriptions.
 * This allows the AI to understand what each tool can do.
 *
 * @param options.skipConnection - If true, only returns config metadata without connecting to servers.
 *                                 Use this for lazy loading - tools will be fetched on-demand later.
 */
export async function getDetailedMcpToolInfo(
	options: GetMcpToolsOptions & { skipConnection?: boolean },
): Promise<DetailedMcpToolInfo[]> {
	const {
		userId,
		organizationId,
		enabledMcpConfigIds,
		skipConnection = false,
	} = options;

	// Handle filtering:
	// - null/undefined = no filter, return all enabled configs
	// - [] (empty array) = explicitly disabled all, return none
	// - ["id1", "id2"] = filter to specific IDs
	const hasExplicitFilter =
		enabledMcpConfigIds !== null && enabledMcpConfigIds !== undefined;
	const isExplicitlyEmpty =
		hasExplicitFilter && enabledMcpConfigIds.length === 0;

	// If user explicitly disabled all MCP servers, return empty array early
	if (isExplicitlyEmpty) {
		console.log(
			"[MCP Tools] All MCP servers explicitly disabled, returning empty",
		);
		return [];
	}

	// SECURITY: Strict tenant isolation - use same pattern as getTenantMcpConfigs
	// Per-user-within-org pattern: configs have both userId AND organizationId set
	// Always filter by userId to prevent credential leakage between org members
	const mcpConfigs = await db.mCPConfig.findMany({
		where: {
			userId, // Always filter by current user (credentials are per-user)
			...(organizationId
				? { organizationId } // Org context: current user's configs within this org
				: { organizationId: null }), // Personal context: only user configs
			enabled: true,
			// Configs tripped by the refresh circuit breaker can't produce tools
			// until the user re-authenticates, so skip them at discovery instead
			// of failing per-request.
			//
			// Scoped to OAUTH2: `needsReauth` describes an OAuth GRANT and only
			// an OAuth reconnect clears it, so a config since edited to API_KEY
			// or NONE would otherwise stay invisible forever while holding a
			// perfectly good credential. Prisma ANDs top-level keys, so this
			// `OR` composes with `userId`, the XOR `organizationId`, `enabled`
			// and the optional `id` filter rather than replacing any of them.
			OR: [{ authType: { not: "OAUTH2" } }, { needsReauth: false }],
			...(hasExplicitFilter ? { id: { in: enabledMcpConfigIds } } : {}),
		},
		include: { mcpServer: true },
		// Without an order this is Postgres' physical row order, which decides
		// which servers' tools survive the per-request schema budget — so the
		// same question could reach the model with a different tool set on
		// each attempt, and any config write could reshuffle it. Oldest first
		// is arbitrary but stable.
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
	});

	console.log("[MCP Tools] Loaded configs:", {
		count: mcpConfigs.length,
		hasFilter: hasExplicitFilter,
		filterIds: enabledMcpConfigIds,
		skipConnection,
	});

	// If skipConnection is true, return config metadata without connecting
	// Tools will be loaded on-demand when actually needed
	if (skipConnection) {
		return mcpConfigs.map((config) => ({
			configId: config.id,
			configName:
				config.displayName || config.mcpServer?.name || "Unknown",
			serverName:
				config.displayName || config.mcpServer?.name || "MCP Server",
			tools: [], // Tools will be loaded on-demand
			serviceKeywords: extractKeywordsFromConfig(config),
		}));
	}

	const detailedInfo: DetailedMcpToolInfo[] = [];

	for (const config of mcpConfigs) {
		try {
			const result = await getMcpClient(
				config.id,
				userId,
				organizationId,
			);
			if (result) {
				const tools = await result.client.tools();
				const toolList: DetailedMcpToolInfo["tools"] = [];
				const serviceKeywords: string[] = [];

				for (const [name, def] of Object.entries(tools)) {
					const toolDef = def as {
						description?: string;
						inputSchema?: Record<string, unknown>;
					};
					toolList.push({
						name,
						description: toolDef.description || "No description",
						inputSchema: toolDef.inputSchema,
					});

					// Extract keywords from tool name for matching
					const nameParts = name.toLowerCase().split(/[_-]/);
					serviceKeywords.push(...nameParts);

					// Extract keywords from description
					if (toolDef.description) {
						const descWords = toolDef.description
							.toLowerCase()
							.split(/\s+/)
							.filter((w) => w.length > 3);
						serviceKeywords.push(...descWords.slice(0, 5));
					}
				}

				detailedInfo.push({
					configId: config.id,
					configName:
						config.displayName ||
						config.mcpServer?.name ||
						"Unknown",
					serverName: result.serverName,
					tools: toolList,
					serviceKeywords: [...new Set(serviceKeywords)], // Dedupe
				});

				await closeMcpClientSafe(result.client);
			}
		} catch (e) {
			console.warn(
				`[MCP Tools] Failed to get tools from ${config.displayName}:`,
				e,
			);
		}
	}

	return detailedInfo;
}

/**
 * Extract keywords from config metadata without connecting to server
 */
function extractKeywordsFromConfig(config: {
	displayName: string | null;
	mcpServer?: { name: string } | null;
}): string[] {
	const keywords: string[] = [];
	const name = config.displayName || config.mcpServer?.name || "";

	// Extract keywords from server name
	const nameParts = name.toLowerCase().split(/[\s_-]+/);
	keywords.push(...nameParts.filter((p) => p.length > 2));

	return [...new Set(keywords)];
}

// ============================================================================
// Task-to-Tool Matching
// ============================================================================

/**
 * Determines if MCP tools can handle a task and returns ONLY relevant tools.
 *
 * CRITICAL: This function must:
 * 1. Be DYNAMIC - work with ANY MCP server, not hardcoded service names
 * 2. Match tools based on INTENT - read vs write operations
 * 3. ONLY return tools that match what the user ASKED for
 */
export function canMcpToolsHandleTask(
	taskDescription: string,
	mcpToolInfo: DetailedMcpToolInfo[],
): McpToolMatchResult {
	const taskLower = taskDescription.toLowerCase();
	const matchedTools: McpToolMatchResult["matchedTools"] = [];
	let totalScore = 0;

	// STEP 1: Determine the INTENT of the task (read-only vs write operations)
	const readVerbs = [
		"get",
		"list",
		"show",
		"fetch",
		"find",
		"search",
		"query",
		"read",
		"display",
		"view",
		"what",
		"give me",
		"tell me",
	];
	const writeVerbs = ["create", "add", "new", "make", "post", "insert"];
	const updateVerbs = ["update", "edit", "modify", "change", "set", "rename"];
	const deleteVerbs = ["delete", "remove", "clear", "destroy", "drop"];

	const hasReadIntent = readVerbs.some((v) => taskLower.includes(v));
	const hasWriteIntent = writeVerbs.some((v) => taskLower.includes(v));
	const hasUpdateIntent = updateVerbs.some((v) => taskLower.includes(v));
	const hasDeleteIntent = deleteVerbs.some((v) => taskLower.includes(v));

	const isReadOnly =
		hasReadIntent &&
		!hasWriteIntent &&
		!hasUpdateIntent &&
		!hasDeleteIntent;

	// STEP 2: Extract nouns/entities from the task to match against tools
	const stopWords = new Set([
		"the",
		"a",
		"an",
		"in",
		"on",
		"at",
		"to",
		"for",
		"from",
		"with",
		"and",
		"or",
		"all",
		"my",
		"me",
		"give",
		"list",
		"get",
		"show",
		"fetch",
		"find",
	]);
	const taskWords = taskLower
		.replace(/[^\w\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !stopWords.has(w));

	// STEP 3: Match tools DYNAMICALLY
	for (const config of mcpToolInfo) {
		const configNameLower = config.configName.toLowerCase();
		const serverNameLower = config.serverName.toLowerCase();

		// Check if any task word matches the service name
		const serviceMatch = taskWords.some(
			(word) =>
				configNameLower.includes(word) ||
				serverNameLower.includes(word),
		);

		// Also check service keywords from tool name extraction
		const keywordMatch = config.serviceKeywords.some(
			(kw) => taskLower.includes(kw) && kw.length > 2,
		);

		if (serviceMatch || keywordMatch) {
			totalScore += 30; // Base score for matching the service

			// Filter tools based on operation type
			for (const tool of config.tools) {
				const toolNameLower = tool.name.toLowerCase();
				const toolParts = toolNameLower.split(/[_-]/);

				// Determine tool operation type
				const isGetTool = toolParts.some((p) =>
					[
						"get",
						"list",
						"fetch",
						"search",
						"find",
						"query",
						"read",
					].includes(p),
				);
				const isCreateTool = toolParts.some((p) =>
					["create", "add", "new", "post", "insert"].includes(p),
				);
				const isUpdateTool = toolParts.some((p) =>
					["update", "edit", "modify", "set", "patch"].includes(p),
				);
				const isDeleteTool = toolParts.some((p) =>
					["delete", "remove", "destroy", "drop"].includes(p),
				);

				let shouldInclude = false;
				let reason = "";

				if (isReadOnly) {
					// Read-only task: ONLY include GET/LIST tools
					if (
						isGetTool &&
						!isCreateTool &&
						!isUpdateTool &&
						!isDeleteTool
					) {
						const entityMatch = taskWords.some(
							(word) =>
								toolNameLower.includes(word) ||
								toolParts.includes(word) ||
								toolParts.includes(`${word}s`) ||
								toolParts.includes(word.replace(/s$/, "")),
						);

						if (entityMatch) {
							shouldInclude = true;
							reason = `Read operation for: ${taskWords.filter((w) => toolNameLower.includes(w)).join(", ")}`;
						}
					}
				} else {
					// Write/update/delete task: Match based on explicit intent
					if (hasWriteIntent && isCreateTool) {
						shouldInclude = true;
						reason = "Create operation requested";
					}
					if (hasUpdateIntent && isUpdateTool) {
						shouldInclude = true;
						reason = "Update operation requested";
					}
					if (hasDeleteIntent && isDeleteTool) {
						shouldInclude = true;
						reason = "Delete operation requested";
					}
					// Also include GET tools for mixed operations
					if ((hasWriteIntent || hasUpdateIntent) && isGetTool) {
						const entityMatch = taskWords.some((word) =>
							toolNameLower.includes(word),
						);
						if (entityMatch) {
							shouldInclude = true;
							reason = `Read operation (prerequisite for ${hasWriteIntent ? "create" : "update"})`;
						}
					}
				}

				if (shouldInclude) {
					matchedTools.push({
						configId: config.configId,
						toolName: tool.name,
						reason,
					});
					totalScore += 15;
				}
			}
		}
	}

	// STEP 4: If no service-level match, try direct tool name matching
	if (matchedTools.length === 0) {
		for (const config of mcpToolInfo) {
			for (const tool of config.tools) {
				const toolNameLower = tool.name.toLowerCase();
				const toolParts = toolNameLower.split(/[_-]/);

				// Check for strong entity match (2+ parts from task)
				const matchingParts = taskWords.filter((word) =>
					toolParts.some(
						(part) =>
							part === word ||
							part === `${word}s` ||
							`${part}s` === word,
					),
				);

				if (matchingParts.length >= 2) {
					const isGetTool = toolParts.some((p) =>
						["get", "list", "fetch", "search", "find"].includes(p),
					);
					const isWriteTool = toolParts.some((p) =>
						[
							"create",
							"add",
							"update",
							"delete",
							"remove",
						].includes(p),
					);

					if (isReadOnly && isGetTool) {
						matchedTools.push({
							configId: config.configId,
							toolName: tool.name,
							reason: `Matches: ${matchingParts.join(", ")}`,
						});
						totalScore += 20;
					} else if (!isReadOnly && isWriteTool) {
						matchedTools.push({
							configId: config.configId,
							toolName: tool.name,
							reason: `Write operation matches: ${matchingParts.join(", ")}`,
						});
						totalScore += 20;
					}
				}
			}
		}
	}

	// Normalize score to 0-100
	const confidence = Math.min(100, totalScore);
	const canHandle = matchedTools.length > 0 && confidence >= 20;

	return {
		canHandle,
		confidence,
		matchedTools,
		isReadOnly,
		reasoning:
			matchedTools.length > 0
				? `Found ${matchedTools.length} matching tools with ${confidence}% confidence`
				: "No matching tools found for this task",
	};
}

// ============================================================================
// Default-Enabled MCP Configs (registry-driven managed defaults)
// ============================================================================

/**
 * Returns the MCPConfig ids for every server flagged `defaultEnabled=true`
 * in the registry, scoped to the caller's tenant (XOR filter: organizationId
 * EITHER provided OR null — never both, never an OR). Tolerant of missing
 * rows: returns an empty array instead of throwing, so it stays safe to call
 * during partial rollouts and from inside hot paths.
 *
 * After the backfill migration runs, every active tenant has exactly one
 * sentinel row per default-enabled server. New tenants are seeded by the
 * post-signup / post-member-add hooks in `packages/auth/auth.ts`.
 *
 * Used by:
 *   - The Nexus chat-send orchestrator-start procedure (under
 *     `packages/api/modules/ai/procedures/orchestrator/*.ts`) to union
 *     default-enabled ids into `enabledMcpConfigIds` before workflow start.
 *   - The AI Assistant entry point used by `FabricDirectChat` — same
 *     orchestrator-start path, different `surface` literal.
 *   - Future CopilotKit MCP integration (when in scope) — same call site.
 *
 * v1: joins `mcpServer.defaultEnabled = true` AND `mcpServer.isSystemProvided = true`
 * so custom (non-system) servers can never accidentally appear as
 * default-enabled. Tenant XOR per AGENTS.md / fabric/standards/backend/queries.md.
 */
export async function getDefaultEnabledMcpConfigIds(
	userId: string,
	organizationId: string | null,
): Promise<string[]> {
	const tenantFilter = {
		userId,
		organizationId: organizationId ?? null,
	} satisfies { userId: string; organizationId: string | null };

	const configs = await db.mCPConfig.findMany({
		where: {
			...tenantFilter,
			enabled: true,
			mcpServer: {
				defaultEnabled: true,
				isSystemProvided: true,
			},
		},
		select: { id: true },
	});

	return configs.map((c) => c.id);
}

/**
 * Seed managed-default `MCPConfig` sentinel rows for a given tenant tuple.
 *
 * Adding the next default-enabled server (e.g. Mermaid) costs zero new hook
 * code — the helper iterates every `MCPServer` row flagged
 * `defaultEnabled = true` AND `isSystemProvided = true`, so flipping the seed
 * in `packages/database/prisma/seed-enterprise-mcp.ts` is sufficient. This is
 * the single source of truth that all three Better Auth hooks call (post
 * user-create, post org-create, post member-add / invite-accept) so the
 * post-backfill invariant is maintained going forward.
 *
 * Idempotent — checks `(userId, organizationId, mcpServerId)` for an existing
 * row before each insert and skips if present. Safe to call repeatedly from
 * any hook without producing duplicates (or to call after the backfill SQL).
 *
 * Tenant XOR: `organizationId` is either a string (org context) or `null`
 * (personal context) — never both, never `undefined`. Per
 * `fabric/standards/backend/queries.md` and `AGENTS.md`. The existence check
 * AND the insert both pass the literal value.
 *
 * Sentinel row shape: `authType: "NONE"`, `enabled: true`,
 * `isManagedDefault: true`. The migration's backfill produces identical rows.
 *
 * Best-effort: callers wrap in try/catch and SWALLOW errors (the next signin
 * / next eager-load defends downstream).
 */
export async function seedDefaultMcpConfigsForTenant(params: {
	userId: string;
	organizationId: string | null;
}): Promise<void> {
	const { userId, organizationId } = params;

	const defaultServers = await db.mCPServer.findMany({
		where: { defaultEnabled: true, isSystemProvided: true },
		select: { id: true, key: true },
	});

	if (defaultServers.length === 0) {
		return;
	}

	for (const server of defaultServers) {
		const existing = await db.mCPConfig.findFirst({
			where: {
				userId,
				organizationId: organizationId ?? null,
				mcpServerId: server.id,
			},
			select: { id: true },
		});
		if (existing) {
			continue;
		}

		await db.mCPConfig.create({
			data: {
				mcpServerId: server.id,
				userId,
				organizationId: organizationId ?? null,
				authType: "NONE",
				enabled: true,
				isManagedDefault: true,
			},
		});

		console.info("[seedDefaultMcpConfigsForTenant] Seeded sentinel row", {
			serverKey: server.key,
			userId,
			organizationId: organizationId ?? null,
		});
	}
}
