/**
 * Tool Loader
 *
 * Handles loading MCP tools for step execution.
 * Manages MCP client connections and tool filtering based on step configuration.
 */

import { tool } from "@repo/ai";
import { db } from "@repo/database";
import { executeGitHubTool } from "@repo/integrations/github";
import { executeGitLabTool } from "@repo/integrations/gitlab";
import { executeSlackTool } from "@repo/integrations/slack";
import {
	getCachedMcpClientForConfig,
	OAuthAuthorizationRequiredError,
} from "@repo/mcp";
import type { AccountDefinition } from "@repo/mcp-registry";
import { getBaseUrl } from "@repo/utils";
import { executeMicrosoftTeamsTool } from "../../../shared/oauth-tool-executors";
import type { ExecuteStepInput } from "../../types";
import { jsonSchemaToZod } from "../../utils";
import type {
	AuthRequiredConfig,
	LoadedMcpTools,
	McpToolInfo,
} from "../handlers/types";

function extractMcpAppResourceUri(toolDef: unknown): string | undefined {
	return (
		toolDef as {
			_meta?: { ui?: { resourceUri?: string } };
		}
	)?._meta?.ui?.resourceUri;
}

/**
 * Load MCP tools for step execution.
 * Handles preloaded tools, selective loading, and fallback to database queries.
 */
export async function loadMcpTools(
	input: ExecuteStepInput,
): Promise<LoadedMcpTools> {
	const allTools: Record<string, unknown> = {};
	const toolToConfig: Record<string, McpToolInfo> = {};
	const authRequiredConfigs: AuthRequiredConfig[] = [];

	// Get enabled config IDs - use preloaded data if available
	let mcpFilterIds: string[] | undefined;
	let mcpExplicitlyDisabled = false;

	// Check toolsToUse and app for selective loading
	const stepToolsToUse = input.step.toolsToUse;
	const stepApp = input.step.app;
	const hasSpecificTools = stepToolsToUse && stepToolsToUse.length > 0;

	const inferredTools: string[] = [];
	if (!hasSpecificTools && stepApp && input.preloadedTools?.toolMap) {
		if (input.preloadedTools.toolMap[stepApp]) {
			inferredTools.push(stepApp);
			console.log(
				`[ToolLoader] Using exact tool from step.app: ${stepApp}`,
			);
		} else {
			const appPrefix = stepApp.split("_")[0];
			if (appPrefix && appPrefix.length >= 3) {
				for (const toolName of Object.keys(
					input.preloadedTools.toolMap,
				)) {
					if (
						toolName.startsWith(appPrefix) &&
						!inferredTools.includes(toolName)
					) {
						inferredTools.push(toolName);
					}
				}
				if (inferredTools.length > 0) {
					console.log(
						`[ToolLoader] Using tools matching prefix '${appPrefix}': ${inferredTools.length} tools`,
					);
				}
			}
		}
	}

	const effectiveToolsToUse = hasSpecificTools
		? stepToolsToUse
		: inferredTools.length > 0
			? inferredTools
			: null;

	// Use matchedMcpTools from routing if available
	if (input.matchedMcpTools && input.matchedMcpTools.length > 0) {
		const configIds = new Set<string>();
		for (const tool of input.matchedMcpTools) {
			if (tool.configId) {
				configIds.add(tool.configId);
			}
		}
		if (configIds.size > 0) {
			mcpFilterIds = Array.from(configIds);
			console.log(
				"[ToolLoader] Using matchedMcpTools from routing for MCP filter",
				{
					matchedTools: input.matchedMcpTools.map((t) => t.toolName),
					configCount: configIds.size,
				},
			);
		}
	}

	// Use preloaded tools if available
	if (
		input.preloadedTools?.toolMap &&
		Object.keys(input.preloadedTools.toolMap).length > 0 &&
		!mcpFilterIds
	) {
		const configIds = new Set<string>();

		if (effectiveToolsToUse && effectiveToolsToUse.length > 0) {
			for (const toolName of effectiveToolsToUse) {
				const toolInfo = input.preloadedTools.toolMap[toolName];
				if (toolInfo) {
					configIds.add(toolInfo.configId);
				}
			}
			console.log("[ToolLoader] Selective MCP loading", {
				source: hasSpecificTools ? "toolsToUse" : "inferred from app",
				requestedTools: effectiveToolsToUse,
				configCount: configIds.size,
			});
		} else {
			for (const toolInfo of Object.values(
				input.preloadedTools.toolMap,
			)) {
				configIds.add(toolInfo.configId);
			}
			console.log(
				"[ToolLoader] Loading all preloaded tool configs (no specific tools)",
				{
					configCount: configIds.size,
					toolCount: Object.keys(input.preloadedTools.toolMap).length,
				},
			);
		}

		mcpFilterIds = Array.from(configIds);
	} else if (!mcpFilterIds) {
		// Fallback: Query database for enabled MCP config IDs
		console.log(
			"[ToolLoader] No preloaded tools, querying database for preferences",
		);

		mcpFilterIds = input.enabledMcpConfigIds ?? undefined;
		mcpExplicitlyDisabled =
			Array.isArray(input.enabledMcpConfigIds) &&
			input.enabledMcpConfigIds.length === 0;

		const execDbPrefs = await db.userOrchestratorPreferences.findUnique({
			where: {
				userId_organizationId: {
					userId: input.userId,
					organizationId: input.organizationId || "",
				},
			},
		});

		if (execDbPrefs) {
			const dbEnabledMcpIds = execDbPrefs.enabledMcpConfigIds as string[];
			console.log(
				"[ToolLoader] Using database preferences for MCP filter",
				{
					dbIds: dbEnabledMcpIds.length,
					frontendIds: input.enabledMcpConfigIds?.length ?? "null",
				},
			);
			mcpFilterIds =
				dbEnabledMcpIds.length > 0 ? dbEnabledMcpIds : undefined;
			mcpExplicitlyDisabled = dbEnabledMcpIds.length === 0;
		}
	}

	// Even if MCP configs are disabled, check for OAuth integrations
	// OAuth integrations (GitHub, Microsoft Teams) provide tools via WorkflowIntegration table
	const oauthTools = await loadOAuthIntegrationTools(
		input.userId,
		input.organizationId,
	);

	if (oauthTools.length > 0) {
		console.log(
			`[ToolLoader] Loaded ${oauthTools.length} tools from OAuth integrations`,
		);
		for (const oauthTool of oauthTools) {
			// Convert JSON Schema to Zod schema for AI SDK compatibility
			const zodSchema = jsonSchemaToZod(oauthTool.inputSchema);

			// Create AI SDK compatible tool using the tool() function (same as chart-tool.ts)
			// Use double cast since schema is dynamically generated and TypeScript can't infer types
			allTools[oauthTool.name] = tool({
				description: oauthTool.description,
				inputSchema: zodSchema,
				execute: async (args: Record<string, unknown>) =>
					oauthTool.execute(args),
			} as unknown as Parameters<typeof tool>[0]);
			toolToConfig[oauthTool.name] = {
				configId: oauthTool.configId,
				serverName: oauthTool.serverName,
				originalName: oauthTool.originalName,
				resourceUri: undefined,
			};
		}
	}

	if (mcpExplicitlyDisabled) {
		// If MCP configs are disabled but we have OAuth tools, return those
		if (oauthTools.length > 0) {
			console.log(
				"[ToolLoader] MCP configs disabled, but loaded OAuth integration tools",
			);
			return { tools: allTools, toolToConfig };
		}
		console.log(
			"[ToolLoader] All MCP servers disabled by user, no tools loaded",
		);
		return { tools: allTools, toolToConfig };
	}

	// Load MCP configs with per-user isolation
	// Each user has their own configs, even within orgs
	let mcpConfigs = await db.mCPConfig.findMany({
		where: {
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			enabled: true,
			...(mcpFilterIds && mcpFilterIds.length > 0
				? { id: { in: mcpFilterIds } }
				: {}),
		},
		include: { mcpServer: true },
	});

	// Filter by step.app prefix if specified
	if (stepApp && mcpConfigs.length > 1) {
		const appPrefix = stepApp.split("_")[0]?.toLowerCase();
		if (appPrefix && appPrefix.length >= 3) {
			const filteredConfigs = mcpConfigs.filter((config) => {
				const serverName = (
					config.displayName ||
					config.mcpServer?.name ||
					""
				).toLowerCase();
				return (
					serverName.includes(appPrefix) ||
					appPrefix.includes(serverName.split(" ")[0])
				);
			});

			if (filteredConfigs.length > 0) {
				console.log(
					`[ToolLoader] Filtering MCP configs by step.app prefix '${appPrefix}'`,
					{
						before: mcpConfigs.length,
						after: filteredConfigs.length,
					},
				);
				mcpConfigs = filteredConfigs;
			}
		}
	}

	console.log("[ToolLoader] Loading MCP tools in parallel", {
		configCount: mcpConfigs.length,
		hasFilter: !!mcpFilterIds,
	});

	// Build redirect URI for OAuth2 support
	const baseUrl = getBaseUrl();
	const redirectUri = `${baseUrl}/api/mcp/oauth/callback`;

	// Load MCP tools in parallel
	const mcpLoadStartTime = Date.now();
	const mcpLoadResults = await Promise.allSettled(
		mcpConfigs.map(async (config) => {
			try {
				const result = await getCachedMcpClientForConfig({
					configId: config.id,
					userId: input.userId,
					organizationId: input.organizationId,
					redirectUri, // Enable OAuth2 token refresh
				});
				if (result) {
					if (!result.fromCache) {
						console.log(
							`[ToolLoader] Created new MCP connection to ${result.serverName}`,
						);
					} else {
						console.log(
							`[ToolLoader] Reusing cached MCP connection to ${result.serverName}`,
						);
					}
					const tools = await result.client.tools();
					return { config, result, tools };
				}
				return null;
			} catch (e) {
				// Handle OAuth authorization required errors specially
				if (e instanceof OAuthAuthorizationRequiredError) {
					console.warn(
						`[ToolLoader] OAuth authorization required for ${config.displayName}`,
						e.message,
					);
					// Return auth required info so handler can propagate it
					return {
						authRequired: true,
						configId: e.configId || config.id,
						serverName:
							e.serverName || config.displayName || "Unknown",
						displayName: config.displayName,
					};
				}
				console.warn(`Failed to connect to ${config.displayName}`, e);
				return null;
			}
		}),
	);

	console.log(
		`[ToolLoader] MCP parallel load completed in ${Date.now() - mcpLoadStartTime}ms`,
	);

	// Process results - both successful loads and auth required errors
	for (const loadResult of mcpLoadResults) {
		if (loadResult.status === "fulfilled" && loadResult.value) {
			const value = loadResult.value;

			// Check if this is an auth required result
			if ("authRequired" in value && value.authRequired) {
				authRequiredConfigs.push({
					configId: value.configId as string,
					serverName: value.serverName as string,
					displayName: value.displayName as string | undefined,
				});
				console.log(
					`[ToolLoader] Tracked auth required config: ${value.displayName || value.serverName}`,
				);
				continue;
			}

			// Process successful tool load - must have config, result, tools
			if (
				!("config" in value) ||
				!("result" in value) ||
				!("tools" in value)
			) {
				continue;
			}
			const { config, result, tools } = value;
			if (!config || !result || !tools) {
				continue;
			}
			const toolNamesList = Object.keys(tools);
			console.log(
				`[ToolLoader] Loaded ${toolNamesList.length} tools from ${result.serverName}`,
			);
			for (const [name, def] of Object.entries(tools)) {
				allTools[name] = def;
				toolToConfig[name] = {
					configId: config.id,
					serverName: result.serverName,
					originalName: name,
					resourceUri: extractMcpAppResourceUri(def),
				};
			}
		}
	}

	// Log summary of auth required configs
	if (authRequiredConfigs.length > 0) {
		console.log(
			`[ToolLoader] ${authRequiredConfigs.length} MCP server(s) require OAuth authorization`,
			authRequiredConfigs.map((c) => c.displayName || c.serverName),
		);
	}

	return {
		tools: allTools,
		toolToConfig,
		authRequiredConfigs:
			authRequiredConfigs.length > 0 ? authRequiredConfigs : undefined,
	};
}

interface OAuthToolInfo {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	configId: string;
	serverName: string;
	originalName: string;
	execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Load tools from OAuth integrations (GitHub, Microsoft Teams).
 * These tools are available when users have connected their accounts via OAuth,
 * without requiring a separate MCP config.
 */
async function loadOAuthIntegrationTools(
	userId: string,
	organizationId: string | null | undefined,
): Promise<OAuthToolInfo[]> {
	const tools: OAuthToolInfo[] = [];

	// Check for GitHub integration
	// Uses XOR pattern: org context requires both userId AND organizationId for per-user isolation
	const githubIntegration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
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
		try {
			const { GITHUB_ACCOUNT } = (await import("@repo/mcp-registry")) as {
				GITHUB_ACCOUNT: AccountDefinition;
			};

			for (const mcp of GITHUB_ACCOUNT.mcps) {
				if (mcp.available === false) {
					continue;
				}

				const serverName = mcp.serverName || mcp.name;
				if (mcp.tools) {
					for (const tool of mcp.tools) {
						const toolName = `${serverName}__${tool.name}`;
						const originalToolName = tool.name;
						tools.push({
							name: toolName,
							description: tool.description || "",
							inputSchema: (tool.inputSchema as Record<
								string,
								unknown
							>) || {
								type: "object",
							},
							configId: `github-connected:${GITHUB_ACCOUNT.id}:${mcp.id}`,
							serverName,
							originalName: originalToolName,
							execute: async (args: Record<string, unknown>) => {
								return executeGitHubTool(
									originalToolName,
									args,
									userId,
									organizationId ?? undefined,
								);
							},
						});
					}
				}
			}
			console.log(
				`[ToolLoader] Loaded ${tools.length} tools from GitHub OAuth integration`,
			);
		} catch (e) {
			console.warn(
				"[ToolLoader] Failed to load GitHub tools from registry",
				e,
			);
		}
	}

	// Check for Microsoft Teams integration (uses XOR pattern for tenant isolation)
	const microsoftIntegration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
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
		try {
			const { MICROSOFT_TEAMS_ACCOUNT } = (await import(
				"@repo/mcp-registry"
			)) as { MICROSOFT_TEAMS_ACCOUNT: AccountDefinition };

			const msToolsStart = tools.length;
			for (const mcp of MICROSOFT_TEAMS_ACCOUNT.mcps) {
				if (mcp.available === false) {
					continue;
				}

				const serverName = mcp.serverName || mcp.name;
				if (mcp.tools) {
					for (const tool of mcp.tools) {
						const toolName = `${serverName}__${tool.name}`;
						const originalToolName = tool.name;
						tools.push({
							name: toolName,
							description: tool.description || "",
							inputSchema: (tool.inputSchema as Record<
								string,
								unknown
							>) || {
								type: "object",
							},
							configId: `microsoft-teams-connected:${MICROSOFT_TEAMS_ACCOUNT.id}:${mcp.id}`,
							serverName,
							originalName: originalToolName,
							execute: async (args: Record<string, unknown>) => {
								return executeMicrosoftTeamsTool(
									originalToolName,
									args,
									userId,
									organizationId ?? undefined,
								);
							},
						});
					}
				}
			}
			console.log(
				`[ToolLoader] Loaded ${tools.length - msToolsStart} tools from Microsoft Teams OAuth integration`,
			);
		} catch (e) {
			console.warn(
				"[ToolLoader] Failed to load Microsoft Teams tools from registry",
				e,
			);
		}
	}

	// Check for GitLab integration (uses XOR pattern for tenant isolation)
	const gitlabIntegration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "GITLAB",
					isActive: true,
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "GITLAB",
					isActive: true,
				},
			});

	if (gitlabIntegration) {
		try {
			const { GITLAB_ACCOUNT } = (await import("@repo/mcp-registry")) as {
				GITLAB_ACCOUNT: AccountDefinition;
			};

			const glToolsStart = tools.length;
			for (const mcp of GITLAB_ACCOUNT.mcps) {
				if (mcp.available === false) {
					continue;
				}

				const serverName = mcp.serverName || mcp.name;
				if (mcp.tools) {
					for (const tool of mcp.tools) {
						const toolName = `${serverName}__${tool.name}`;
						const originalToolName = tool.name;
						tools.push({
							name: toolName,
							description: tool.description || "",
							inputSchema: (tool.inputSchema as Record<
								string,
								unknown
							>) || {
								type: "object",
							},
							configId: `gitlab-connected:${GITLAB_ACCOUNT.id}:${mcp.id}`,
							serverName,
							originalName: originalToolName,
							execute: async (args: Record<string, unknown>) => {
								return executeGitLabTool(
									originalToolName,
									args,
									userId,
									organizationId ?? undefined,
								);
							},
						});
					}
				}
			}
			console.log(
				`[ToolLoader] Loaded ${tools.length - glToolsStart} tools from GitLab OAuth integration`,
			);
		} catch (e) {
			console.warn(
				"[ToolLoader] Failed to load GitLab tools from registry",
				e,
			);
		}
	}

	// Check for Slack integration (uses XOR pattern for tenant isolation)
	const slackIntegration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "SLACK",
					isActive: true,
					NOT: { name: "SLACK_OAUTH_APP" },
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "SLACK",
					isActive: true,
					NOT: { name: "SLACK_OAUTH_APP" },
				},
			});

	if (slackIntegration) {
		const slackToolsStart = tools.length;
		const slackToolDefs = [
			{
				name: "list_channels",
				description: "List Slack workspace channels",
			},
			{
				name: "get_channel_messages",
				description: "Get recent messages from a Slack channel",
			},
			{
				name: "search_messages",
				description: "Search messages across Slack workspace",
			},
			{
				name: "get_channel_info",
				description: "Get details about a Slack channel",
			},
			{
				name: "list_users",
				description: "List Slack workspace members",
			},
		];

		for (const toolDef of slackToolDefs) {
			const toolName = `Slack__${toolDef.name}`;
			tools.push({
				name: toolName,
				description: toolDef.description,
				inputSchema: { type: "object" },
				configId: `slack-connected:${slackIntegration.id}`,
				serverName: "Slack",
				originalName: toolDef.name,
				execute: async (args: Record<string, unknown>) => {
					return executeSlackTool(
						toolDef.name,
						args,
						userId,
						organizationId ?? undefined,
					);
				},
			});
		}
		console.log(
			`[ToolLoader] Loaded ${tools.length - slackToolsStart} tools from Slack OAuth integration`,
		);
	}

	return tools;
}
