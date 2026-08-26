/**
 * Resource Preloading Activity
 *
 * Loads required resources at workflow start to avoid redundant database queries.
 *
 * LAZY MCP LOADING:
 * MCP connections are NO LONGER made during preload. Instead:
 * - Only config metadata is loaded (server names, IDs)
 * - Actual tool loading happens on-demand during step execution
 * - This dramatically reduces initialization time
 *
 * OAUTH INTEGRATION TOOLS:
 * OAuth integration tools (Microsoft Teams, GitHub) are loaded from WorkflowIntegration
 * table and added to the toolMap so they're available for iterative execution.
 *
 * Performance improvements:
 * - Loading user preferences once instead of per-step
 * - Loading agent registry once instead of per-step
 * - MCP tools loaded lazily when actually needed
 * - OAuth tools loaded eagerly (definitions only, not connections)
 */

import { db, loadProjectDatabricksKnowledgeBinding } from "@repo/database";
import type { AccountDefinition } from "@repo/mcp-registry";
import {
	buildDatabricksKnowledgeToolDefinition,
	databricksKnowledgeToolName,
	loadAgentDatabricksBindings,
	mergeDatabricksBindings,
} from "../../shared/databricks-knowledge";

/**
 * Preloaded resources structure
 */
export interface PreloadedResources {
	userPreferences: {
		enabledMcpConfigIds: string[];
		enabledAgentIds: string[];
		trustLevel: number;
	} | null;

	mcpTools: {
		configId: string;
		serverId: string;
		serverName: string;
		tools: Array<{
			name: string;
			description: string;
			inputSchema: Record<string, unknown>;
		}>;
	}[];

	toolMap: Record<
		string,
		{
			configId: string;
			serverName: string;
			dispatchMetadata?: {
				integrationId: string;
				indexNames: string[];
			};
			definition: {
				name: string;
				description: string;
				inputSchema: Record<string, unknown>;
			};
		}
	>;

	agents: Array<{
		agentId: string;
		displayName: string;
		description: string;
		endpoint: string | null;
		protocol: string;
		capabilities: Record<string, unknown>;
	}>;

	loadedAt: string;
	loadDurationMs: number;
	/** Combined workflow guidance from all connected integrations/MCPs (injected into system prompt) */
	workflowGuidance: string;
}

export interface PreloadResourcesInput {
	userId: string;
	organizationId?: string;
	enabledMcpConfigIds?: string[];
	enabledAgentIds?: string[];
	/** OAuth integration IDs (raw IDs, not prefixed) */
	enabledIntegrationIds?: string[];
	/** Agent template instance whose scoped knowledge tools should be loaded */
	instanceId?: string;
	/**
	 * Project whose Databricks knowledge binding (if any) should be exposed as
	 * a `search_databricks_indexes` tool alongside any agent-level bindings.
	 */
	projectId?: string;
}

/**
 * Preloads all resources needed for workflow execution.
 * This should be called ONCE at workflow start, and the result
 * passed to all step executions.
 */
export async function preloadResourcesActivity(
	input: PreloadResourcesInput,
): Promise<PreloadedResources> {
	const startTime = Date.now();
	console.log("[Preload] Starting resource preloading...");

	// Run all loads in parallel for maximum efficiency
	const [
		userPreferences,
		mcpToolsResult,
		oauthToolsResult,
		agents,
		agentDatabricksBindings,
		projectDatabricksBinding,
	] = await Promise.all([
		loadUserPreferences(input.userId, input.organizationId),
		loadMcpTools(
			input.userId,
			input.organizationId,
			input.enabledMcpConfigIds,
		),
		loadOAuthIntegrationTools(
			input.userId,
			input.organizationId,
			input.enabledMcpConfigIds,
			input.enabledIntegrationIds,
		),
		loadAgents(input.userId, input.organizationId, input.enabledAgentIds),
		input.instanceId
			? loadAgentDatabricksBindings({
					instanceId: input.instanceId,
					userId: input.userId,
					organizationId: input.organizationId,
				})
			: Promise.resolve([]),
		input.projectId
			? loadProjectDatabricksKnowledgeBinding({
					projectId: input.projectId,
					userId: input.userId,
					organizationId: input.organizationId,
				})
			: Promise.resolve(null),
	]);

	// Merge agent-level and project-level bindings per integration BEFORE
	// naming tools — two bindings for the same integration union their
	// indexes, and distinct integrations get deterministic suffixed names.
	const databricksBindings = mergeDatabricksBindings([
		...agentDatabricksBindings,
		...(projectDatabricksBinding ? [projectDatabricksBinding] : []),
	]);

	const databricksToolMap: PreloadedResources["toolMap"] = {};
	for (const [index, binding] of databricksBindings.entries()) {
		const definition = buildDatabricksKnowledgeToolDefinition(binding);
		const toolName = databricksKnowledgeToolName(index);
		databricksToolMap[toolName] = {
			configId: `databricks-vector-search:${binding.integrationId}`,
			serverName: "databricks-vector-search",
			dispatchMetadata: {
				integrationId: binding.integrationId,
				indexNames: binding.indexNames,
			},
			definition,
		};
	}

	// Merge OAuth tools into the toolMap
	const mergedToolMap = {
		...mcpToolsResult.toolMap,
		...oauthToolsResult.toolMap,
		...databricksToolMap,
	};

	// Aggregate workflow guidance from all three sources:
	// 1. Always-enabled MCPs (Sandbox etc.) — generic, always present
	// 2. Account-based MCPs (Google OAuth → Gmail/Docs/Sheets) — from MCPConfig credentialType
	// 3. OAuth workflow integrations (GitHub, Microsoft Teams) — from WorkflowIntegration records
	const { getAlwaysEnabledWorkflowGuidance } = await import(
		"@repo/mcp-registry"
	);
	const alwaysEnabledGuidance = getAlwaysEnabledWorkflowGuidance();
	const allGuidanceParts = [
		alwaysEnabledGuidance,
		mcpToolsResult.workflowGuidance,
		oauthToolsResult.workflowGuidance,
	].filter(Boolean);
	const workflowGuidance = allGuidanceParts.join("\n\n");

	const loadDurationMs = Date.now() - startTime;

	console.log("[Preload] Resource preloading complete", {
		durationMs: loadDurationMs,
		mcpServers: mcpToolsResult.mcpTools.length,
		mcpTools: Object.keys(mcpToolsResult.toolMap).length,
		oauthTools: Object.keys(oauthToolsResult.toolMap).length,
		databricksKnowledgeTools: Object.keys(databricksToolMap).length,
		totalTools: Object.keys(mergedToolMap).length,
		agents: agents.length,
		hasPreferences: !!userPreferences,
		workflowGuidanceLength: workflowGuidance.length,
	});

	return {
		userPreferences,
		mcpTools: mcpToolsResult.mcpTools,
		toolMap: mergedToolMap,
		agents,
		loadedAt: new Date().toISOString(),
		loadDurationMs,
		workflowGuidance,
	};
}

/**
 * Load user orchestrator preferences
 */
async function loadUserPreferences(
	userId: string,
	organizationId?: string,
): Promise<PreloadedResources["userPreferences"]> {
	try {
		const prefs = await db.userOrchestratorPreferences.findUnique({
			where: {
				userId_organizationId: {
					userId,
					organizationId: organizationId || "",
				},
			},
		});

		if (prefs) {
			const trustConfig = prefs.trustConfiguration as Record<
				string,
				unknown
			> | null;
			return {
				enabledMcpConfigIds:
					(prefs.enabledMcpConfigIds as string[]) || [],
				enabledAgentIds: (prefs.enabledAgentIds as string[]) || [],
				trustLevel: (trustConfig?.trustLevel as number) || 50,
			};
		}
		return null;
	} catch (error) {
		console.warn("[Preload] Failed to load user preferences:", error);
		return null;
	}
}

/**
 * Load MCP server configurations (metadata only - no tool loading)
 *
 * For iterative execution mode, tools are discovered on-demand via the
 * search_tools meta-tool. This keeps token usage minimal (~500 tokens
 * for the search tool vs 77K+ for all tool definitions).
 *
 * The search-tools.ts activity handles dynamic tool discovery when needed.
 */
async function loadMcpTools(
	userId: string,
	organizationId?: string,
	enabledMcpConfigIds?: string[],
): Promise<{
	mcpTools: PreloadedResources["mcpTools"];
	toolMap: PreloadedResources["toolMap"];
	workflowGuidance: string;
}> {
	const mcpTools: PreloadedResources["mcpTools"] = [];
	const toolMap: PreloadedResources["toolMap"] = {};
	const seenServerNames = new Set<string>();
	const guidanceParts: string[] = [];

	try {
		// Get enabled config IDs (from input or load from preferences)
		let filterIds = enabledMcpConfigIds;

		if (!filterIds) {
			const prefs = await db.userOrchestratorPreferences.findUnique({
				where: {
					userId_organizationId: {
						userId,
						organizationId: organizationId || "",
					},
				},
			});
			if (prefs) {
				const dbEnabledIds = prefs.enabledMcpConfigIds as string[];
				if (dbEnabledIds && dbEnabledIds.length > 0) {
					filterIds = dbEnabledIds;
				}
			}
		}

		// Check if MCP is explicitly disabled
		if (Array.isArray(filterIds) && filterIds.length === 0) {
			console.log("[Preload] MCP tools disabled by user preferences");
			return { mcpTools, toolMap, workflowGuidance: "" };
		}

		// Load MCP configs (metadata only - NO connections, NO tools)
		// SECURITY: Per-user isolation - each user has their own configs even within orgs
		const mcpConfigs = await db.mCPConfig.findMany({
			where: {
				userId,
				organizationId: organizationId ?? null,
				enabled: true,
				...(filterIds && filterIds.length > 0
					? { id: { in: filterIds } }
					: {}),
			},
			include: { mcpServer: true },
		});

		console.log(
			`[Preload] Found ${mcpConfigs.length} MCP configs (tools will be discovered on-demand)`,
		);

		// Create metadata entries - tools will be discovered via search_tools meta-tool
		for (const config of mcpConfigs) {
			const serverName =
				config.displayName || config.mcpServer?.name || "MCP Server";

			mcpTools.push({
				configId: config.id,
				serverId: config.mcpServerId,
				serverName,
				tools: [], // Tools discovered on-demand via search_tools
			});

			// Collect workflow guidance based on the MCP server name.
			// De-duped: only inject guidance once per server name even if multiple
			// configs use the same server (e.g., two Gmail accounts).
			const mcpServerName = config.mcpServer?.name;
			if (mcpServerName && !seenServerNames.has(mcpServerName)) {
				seenServerNames.add(mcpServerName);
				const { getGuidanceByServerName } = await import(
					"@repo/mcp-registry"
				);
				const guidance = getGuidanceByServerName(mcpServerName);
				if (guidance) {
					guidanceParts.push(guidance);
				}
			}
		}

		console.log(
			"[Preload] MCP config metadata loaded (use search_tools to discover capabilities)",
		);
	} catch (error) {
		console.error("[Preload] Failed to load MCP config metadata:", error);
	}

	return { mcpTools, toolMap, workflowGuidance: guidanceParts.join("\n\n") };
}

/**
 * Load agent registry
 */
async function loadAgents(
	userId: string,
	organizationId?: string,
	enabledAgentIds?: string[],
): Promise<PreloadedResources["agents"]> {
	const agents: PreloadedResources["agents"] = [];

	try {
		const registeredAgents = await db.registeredAgent.findMany({
			where: {
				status: "ACTIVE",
				OR: [
					{ scope: "SYSTEM" },
					{ scope: "USER", userId },
					...(organizationId
						? [{ scope: "ORGANIZATION", organizationId }]
						: []),
				],
			},
			orderBy: [{ scope: "asc" }, { createdAt: "desc" }],
		});

		// Filter by enabled agent IDs if provided
		const filteredAgents = enabledAgentIds
			? registeredAgents.filter((a) =>
					enabledAgentIds.includes(a.agentId),
				)
			: registeredAgents;

		for (const agent of filteredAgents) {
			const metadata = agent.metadata as Record<string, unknown> | null;

			agents.push({
				agentId: agent.agentId,
				displayName: agent.displayName,
				description: agent.description || "",
				endpoint: agent.deploymentUrl,
				protocol: agent.framework, // framework field stores the protocol type
				capabilities: metadata || {},
			});
		}

		console.log(`[Preload] Loaded ${agents.length} agents`);
	} catch (error) {
		console.error("[Preload] Failed to load agents:", error);
	}

	return agents;
}

/**
 * Load OAuth integration tools (Microsoft Teams, GitHub)
 *
 * These tools come from WorkflowIntegration table and represent
 * connected OAuth accounts that provide tool capabilities.
 *
 * IMPORTANT: Respects user orchestrator preferences - only loads tools from
 * integrations that are enabled in the user's orchestrator settings.
 */
async function loadOAuthIntegrationTools(
	userId: string,
	organizationId?: string,
	enabledMcpConfigIds?: string[],
	enabledIntegrationIds?: string[],
): Promise<{
	toolMap: PreloadedResources["toolMap"];
	workflowGuidance: string;
}> {
	const toolMap: PreloadedResources["toolMap"] = {};
	const guidanceParts: string[] = [];

	// Debug: Log incoming IDs
	console.log("[Preload] loadOAuthIntegrationTools input", {
		userId,
		organizationId: organizationId ?? "null",
		enabledMcpConfigIdsFromInput: enabledMcpConfigIds ?? "not provided",
		enabledIntegrationIdsFromInput: enabledIntegrationIds ?? "not provided",
		inputOAuthIds:
			enabledMcpConfigIds?.filter((id) => id.startsWith("oauth:")) ?? [],
	});

	try {
		// Get enabled config IDs from preferences if not provided
		let filterIds = enabledMcpConfigIds;
		let integrationIds = enabledIntegrationIds;

		if (!filterIds) {
			const prefs = await db.userOrchestratorPreferences.findUnique({
				where: {
					userId_organizationId: {
						userId,
						organizationId: organizationId || "",
					},
				},
			});
			if (prefs) {
				const dbEnabledIds = prefs.enabledMcpConfigIds as string[];
				console.log("[Preload] Loaded preferences from DB", {
					dbEnabledIds,
					oauthIds:
						dbEnabledIds?.filter((id) => id.startsWith("oauth:")) ??
						[],
				});
				if (dbEnabledIds && dbEnabledIds.length > 0) {
					filterIds = dbEnabledIds;
					// Extract integration IDs from DB if not provided directly
					if (!integrationIds) {
						integrationIds = dbEnabledIds
							.filter((id) => id.startsWith("oauth:integration:"))
							.map((id) => id.replace("oauth:integration:", ""));
					}
				}
			}
		}

		// If preferences explicitly disable all MCP/OAuth tools (both empty arrays), skip
		// Only skip if BOTH filterIds AND integrationIds are empty arrays
		// This allows OAuth integrations to load even if MCP configs are disabled
		const filterIdsExplicitlyEmpty =
			Array.isArray(filterIds) && filterIds.length === 0;
		const integrationIdsExplicitlyEmpty =
			Array.isArray(integrationIds) && integrationIds.length === 0;

		if (filterIdsExplicitlyEmpty && integrationIdsExplicitlyEmpty) {
			console.log(
				"[Preload] OAuth tools disabled: both MCP configs and integrations explicitly empty",
			);
			return { toolMap, workflowGuidance: "" };
		}

		// Check for Microsoft Teams integration (uses XOR pattern for tenant isolation)
		const microsoftIntegration = organizationId
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

		if (microsoftIntegration) {
			// Check if Microsoft Teams is enabled in orchestrator preferences
			// Support multiple ID formats for backward compatibility:
			// - Direct from enabledIntegrationIds array (raw ID)
			// - New format: oauth:integration:{integrationId} in enabledMcpConfigIds
			// - Legacy formats: oauth:microsoft-teams:{integrationId} or just {integrationId}
			const newFormatId = `oauth:integration:${microsoftIntegration.id}`;
			const legacyFormatId = `oauth:microsoft-teams:${microsoftIntegration.id}`;

			// Check enabledIntegrationIds first (direct array passed from workflow)
			// Then fall back to checking filterIds (enabledMcpConfigIds with prefixed IDs)
			const isEnabledViaIntegrationIds = integrationIds
				? integrationIds.includes(microsoftIntegration.id)
				: false;

			const isEnabledViaFilterIds = filterIds
				? filterIds.includes(newFormatId) ||
					filterIds.includes(legacyFormatId) ||
					filterIds.includes(microsoftIntegration.id)
				: false;

			// If no filter specified at all, allow all (backward compatibility)
			const noFiltersSpecified = !filterIds && !integrationIds;
			const isEnabled =
				noFiltersSpecified ||
				isEnabledViaIntegrationIds ||
				isEnabledViaFilterIds;

			// Debug logging for Teams integration check
			console.log("[Preload] Microsoft Teams integration check", {
				integrationId: microsoftIntegration.id,
				newFormatId,
				legacyFormatId,
				integrationIdsCount: integrationIds?.length ?? 0,
				integrationIds: integrationIds ?? [],
				filterIdsCount: filterIds?.length ?? 0,
				filterIdsOAuthPrefix:
					filterIds?.filter((id: string) =>
						id.startsWith("oauth:"),
					) ?? [],
				isEnabledViaIntegrationIds,
				isEnabledViaFilterIds,
				noFiltersSpecified,
				isEnabled,
			});

			if (!isEnabled) {
				console.log(
					"[Preload] Microsoft Teams integration disabled in orchestrator preferences",
				);
			} else {
				try {
					const { MICROSOFT_TEAMS_ACCOUNT } = (await import(
						"@repo/mcp-registry"
					)) as { MICROSOFT_TEAMS_ACCOUNT: AccountDefinition };

					let msToolCount = 0;
					for (const mcp of MICROSOFT_TEAMS_ACCOUNT.mcps) {
						if (mcp.available === false) {
							continue;
						}

						const serverName = mcp.serverName || mcp.name;
						if (mcp.tools) {
							for (const tool of mcp.tools) {
								const toolName = `${serverName}__${tool.name}`;
								toolMap[toolName] = {
									configId: `microsoft-teams-connected:${MICROSOFT_TEAMS_ACCOUNT.id}:${mcp.id}`,
									serverName,
									definition: {
										name: toolName,
										description: tool.description || "",
										inputSchema:
											(tool.inputSchema as Record<
												string,
												unknown
											>) || {
												type: "object",
											},
									},
								};
								msToolCount++;
							}
						}
						// Collect workflow guidance for system prompt injection
						if (mcp.workflowGuidance) {
							guidanceParts.push(mcp.workflowGuidance);
						}
					}
					console.log(
						`[Preload] Loaded ${msToolCount} tools from Microsoft Teams OAuth integration`,
					);
				} catch (e) {
					console.warn(
						"[Preload] Failed to load Microsoft Teams tools from registry",
						e,
					);
				}
			}
		}

		// Check for GitHub integration (uses XOR pattern for tenant isolation)
		const githubIntegration = organizationId
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

		if (githubIntegration) {
			// Check if GitHub is enabled in orchestrator preferences
			// Support multiple ID formats for backward compatibility:
			// - Direct from enabledIntegrationIds array (raw ID)
			// - New format: oauth:integration:{integrationId} in enabledMcpConfigIds
			// - Legacy formats: oauth:github:{integrationId} or just {integrationId}
			const newFormatId = `oauth:integration:${githubIntegration.id}`;
			const legacyFormatId = `oauth:github:${githubIntegration.id}`;

			// Check enabledIntegrationIds first (direct array passed from workflow)
			// Then fall back to checking filterIds (enabledMcpConfigIds with prefixed IDs)
			const isEnabledViaIntegrationIds = integrationIds
				? integrationIds.includes(githubIntegration.id)
				: false;

			const isEnabledViaFilterIds = filterIds
				? filterIds.includes(newFormatId) ||
					filterIds.includes(legacyFormatId) ||
					filterIds.includes(githubIntegration.id)
				: false;

			// If no filter specified at all, allow all (backward compatibility)
			const noFiltersSpecified = !filterIds && !integrationIds;
			const isEnabled =
				noFiltersSpecified ||
				isEnabledViaIntegrationIds ||
				isEnabledViaFilterIds;

			if (!isEnabled) {
				console.log(
					"[Preload] GitHub integration disabled in orchestrator preferences",
				);
			} else {
				try {
					const { GITHUB_ACCOUNT } = (await import(
						"@repo/mcp-registry"
					)) as { GITHUB_ACCOUNT: AccountDefinition };

					let ghToolCount = 0;
					for (const mcp of GITHUB_ACCOUNT.mcps) {
						if (mcp.available === false) {
							continue;
						}

						const serverName = mcp.serverName || mcp.name;
						if (mcp.tools) {
							for (const tool of mcp.tools) {
								const toolName = `${serverName}__${tool.name}`;
								toolMap[toolName] = {
									configId: `github-connected:${GITHUB_ACCOUNT.id}:${mcp.id}`,
									serverName,
									definition: {
										name: toolName,
										description: tool.description || "",
										inputSchema:
											(tool.inputSchema as Record<
												string,
												unknown
											>) || {
												type: "object",
											},
									},
								};
								ghToolCount++;
							}
						}
						// Collect workflow guidance for system prompt injection
						if (mcp.workflowGuidance) {
							guidanceParts.push(mcp.workflowGuidance);
						}
					}
					console.log(
						`[Preload] Loaded ${ghToolCount} tools from GitHub OAuth integration`,
					);
				} catch (e) {
					console.warn(
						"[Preload] Failed to load GitHub tools from registry",
						e,
					);
				}
			}
		}
	} catch (error) {
		console.error(
			"[Preload] Failed to load OAuth integration tools:",
			error,
		);
	}

	return { toolMap, workflowGuidance: guidanceParts.join("\n\n") };
}
