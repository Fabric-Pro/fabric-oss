/**
 * Template Instance Activities
 *
 * Activities for executing template instances with Fabric AI integration.
 * Handles data fetching, AI analysis, rendering, and artifact storage.
 */

import { generateText } from "@repo/ai";
// Import MCP queries for dynamic discovery
import {
	createTemplateInstanceArtifact,
	createTemplateInstanceArtifactChunks,
	emitReportExecutionNotification,
	fetchCredentialsByProvider,
	finalizeTemplateInstanceExecutionStatus,
	getMcpConfigByIdInternal,
	getMcpServerByKey,
	getTemplateInstance,
	listMcpConfigsForTenant,
	updateTemplateInstanceArtifactRag,
	updateTemplateInstanceLastRunAt,
} from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { logger } from "@repo/logs";
// Import orchestrator activities for MCP execution
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
// Import standard AI model selector from orchestrator
import { getAiModel } from "../orchestrator/utils/model-selector";
import { capRenderedReport } from "./gathered-data-budget";

// =============================================================================
// Types
// =============================================================================

// Connection discovery result
interface DiscoveredConnection {
	type: "mcp" | "integration" | "none";
	mcpConfigId?: string;
	integrationId?: string;
	provider?: string;
}

export interface DataSourceResult {
	sourceId: string;
	sourceType: string;
	data: unknown;
	error?: string;
}

export interface AiAnalysisResult {
	agentId: string;
	task: string;
	output: string;
	outputVariable?: string;
	error?: string;
}

export interface RenderedReport {
	markdown: string;
	title: string;
	generatedAt: string;
}

// =============================================================================
// Fetch Activities
// =============================================================================

export async function fetchTemplateInstanceWithTemplate(input: {
	instanceId: string;
	userId: string;
	organizationId?: string;
}) {
	logger.info("[TemplateInstance] Fetching instance with template", {
		instanceId: input.instanceId,
	});

	const instance = await getTemplateInstance({
		id: input.instanceId,
		userId: input.userId,
		organizationId: input.organizationId,
	});

	return instance;
}

// =============================================================================
// Status Updates
// =============================================================================

export async function updateInstanceExecutionStatus(input: {
	executionId: string;
	instanceId?: string;
	status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
	startedAt?: Date;
	completedAt?: Date;
	duration?: number;
	fabricEnrichment?: Prisma.InputJsonValue;
	dataSources?: Prisma.InputJsonValue;
	mcpDiagnostics?: Prisma.InputJsonValue;
	error?: string;
}): Promise<boolean> {
	// Guarded write: once a user cancels a run, its CANCELLED state is terminal and
	// wins. The workflow's own status writes (RUNNING at start, COMPLETED/FAILED at the
	// end) must never overwrite a CANCELLED row — terminate() cannot kill an in-flight
	// activity, so this write can otherwise land after the cancel flip and clobber it.
	// Returns whether the write landed; a `false` (write skipped because the row is
	// already CANCELLED) is the signal the workflow uses to self-abort.
	const written = await finalizeTemplateInstanceExecutionStatus(
		input.executionId,
		{
			status: input.status,
			startedAt: input.startedAt,
			completedAt: input.completedAt,
			duration: input.duration,
			fabricEnrichment: input.fabricEnrichment,
			dataSources: input.dataSources,
			mcpDiagnostics: input.mcpDiagnostics,
			error: input.error,
		},
	);

	// When execution starts, update the instance's lastRunAt to the start time so
	// "Last run" in the UI reflects when the user triggered it — but only if the
	// RUNNING write actually landed. A skipped write means the run was cancelled
	// before it started, and a cancelled run must not bump lastRunAt.
	if (
		written &&
		input.status === "RUNNING" &&
		input.instanceId &&
		input.startedAt
	) {
		await updateTemplateInstanceLastRunAt(
			input.instanceId,
			input.startedAt,
		);
	}

	return written;
}

// =============================================================================
// Data Source Fetching
// =============================================================================

/**
 * Fetch data via a workflow integration (OAuth or API key based)
 * Maps tool names to integration API calls
 *
 * Can work in two modes:
 * 1. By integration ID - looks up specific integration
 * 2. By provider - uses fetchCredentialsByProvider (like workflow builder)
 */
async function fetchDataViaProviderOrIntegration(input: {
	mcpServerKey: string;
	integrationId?: string;
	useProviderCredentials: boolean;
	toolName: string;
	toolArgs: Record<string, unknown>;
	userId: string;
	organizationId?: string;
}): Promise<unknown> {
	const {
		mcpServerKey,
		integrationId,
		useProviderCredentials,
		toolName,
		toolArgs,
		userId,
		organizationId,
	} = input;

	logger.info("[TemplateInstance] Fetching data via integration/provider", {
		mcpServerKey,
		integrationId,
		useProviderCredentials,
		toolName,
	});

	let token: string;
	let provider: string;
	const settings: Record<string, unknown> = {};

	if (useProviderCredentials) {
		// Use the same pattern as workflow builder - fetch by provider type
		const providerName = mcpServerKey.toUpperCase() as any;
		const credentials = await fetchCredentialsByProvider(
			providerName,
			userId,
			organizationId,
		);

		if (!credentials) {
			throw new Error(
				`No ${mcpServerKey} integration configured. Please set up ${mcpServerKey} in Settings > Integrations.`,
			);
		}

		// Get the token from credentials (keys follow pattern: PROVIDER_API_KEY or PROVIDER_ACCESS_TOKEN)
		const apiKeyName = `${mcpServerKey.toUpperCase()}_API_KEY`;
		const accessTokenName = `${mcpServerKey.toUpperCase()}_ACCESS_TOKEN`;
		const tokenValue =
			(credentials as any)[apiKeyName] ||
			(credentials as any)[accessTokenName];

		if (!tokenValue) {
			throw new Error(
				`No API key or access token found for ${mcpServerKey}. Available keys: ${Object.keys(credentials).join(", ")}`,
			);
		}

		token = tokenValue; // Already decrypted by fetchCredentialsByProvider
		provider = mcpServerKey.toLowerCase();

		logger.info("[TemplateInstance] Using provider credentials", {
			provider,
			hasToken: !!token,
		});
	} else if (integrationId) {
		// Use the same approach as workflow builder - fetch by provider type
		// This ensures consistent credential handling
		const providerName = mcpServerKey.toUpperCase() as any;
		const credentials = await fetchCredentialsByProvider(
			providerName,
			userId,
			organizationId,
		);

		if (!credentials) {
			throw new Error(
				`No ${mcpServerKey} credentials found. Please configure in Settings > Integrations.`,
			);
		}

		// Get the token using the same pattern as workflow builder (e.g., SLACK_API_KEY)
		const apiKeyName = `${mcpServerKey.toUpperCase()}_API_KEY`;
		const tokenValue = (credentials as any)[apiKeyName];

		if (!tokenValue) {
			throw new Error(
				`No API key found for ${mcpServerKey}. Available: ${Object.keys(credentials).join(", ")}`,
			);
		}

		token = tokenValue; // Already decrypted by fetchCredentialsByProvider
		provider = mcpServerKey.toLowerCase();

		logger.info(
			"[TemplateInstance] Using integration credentials (via provider lookup)",
			{
				provider,
				credentialKeys: Object.keys(credentials),
				hasToken: !!token,
			},
		);
	} else {
		throw new Error(
			"Either integrationId or useProviderCredentials must be set",
		);
	}

	switch (provider) {
		case "slack": {
			return await fetchSlackData(token, toolName, toolArgs);
		}
		case "github": {
			return await fetchGitHubData(token, toolName, toolArgs);
		}
		case "linear": {
			return await fetchLinearData(token, toolName, toolArgs);
		}
		case "jira": {
			const baseUrl = (settings as { baseUrl?: string })?.baseUrl;
			return await fetchJiraData(token, toolName, toolArgs, baseUrl);
		}
		default:
			throw new Error(
				`Integration provider "${provider}" not supported for data fetching. Use an MCP server instead.`,
			);
	}
}

/**
 * Fetch data from Slack API
 */
async function fetchSlackData(
	token: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const baseUrl = "https://slack.com/api";

	// Map tool names to Slack API methods
	const methodMap: Record<string, string> = {
		slack_get_channel_history: "conversations.history",
		slack_list_channels: "conversations.list",
		slack_get_channel_info: "conversations.info",
		slack_search_messages: "search.messages",
		slack_list_users: "users.list",
		slack_get_user_info: "users.info",
	};

	const method = methodMap[toolName];
	if (!method) {
		throw new Error(
			`Unknown Slack tool: ${toolName}. Available: ${Object.keys(methodMap).join(", ")}`,
		);
	}

	// Build query params from args
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(args)) {
		if (value !== undefined && value !== null) {
			// Handle special parameter mappings
			let paramKey = key;
			if (key === "channelId") {
				paramKey = "channel"; // Slack API expects 'channel', not 'channelId'
			} else if (key === "channel") {
				paramKey = "channel"; // Keep as-is
			} else {
				// Convert camelCase to snake_case for Slack API
				paramKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
			}
			params.append(paramKey, String(value));
		}
	}

	// Ensure we have a channel parameter for conversation history
	if (method === "conversations.history" && !params.has("channel")) {
		throw new Error(
			`Slack conversations.history requires 'channel' parameter. Received args: ${JSON.stringify(args)}`,
		);
	}

	logger.info("[TemplateInstance] Slack API request", {
		method,
		params: Object.fromEntries(params.entries()),
		hasToken: !!token,
		tokenLength: token?.length,
	});

	const response = await fetch(`${baseUrl}/${method}?${params.toString()}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});

	if (!response.ok) {
		const errorBody = await response.text();
		logger.error("[TemplateInstance] Slack API HTTP error", {
			status: response.status,
			statusText: response.statusText,
			body: errorBody,
		});
		throw new Error(
			`Slack API error: ${response.status} ${response.statusText}`,
		);
	}

	const data = await response.json();

	if (!data.ok) {
		logger.error("[TemplateInstance] Slack API error response", {
			error: data.error,
			needed: data.needed,
			provided: data.provided,
			method,
			params: Object.fromEntries(params.entries()),
		});

		// Provide helpful error messages for common issues
		let errorMessage = `Slack API error: ${data.error || "Unknown error"}`;
		if (data.error === "channel_not_found") {
			errorMessage +=
				". The channel may not exist or the bot doesn't have access to it.";
		} else if (data.error === "missing_scope") {
			errorMessage += `. Required scope: ${data.needed}. Please re-authorize the Slack integration with the correct scopes.`;
		} else if (data.error === "not_in_channel") {
			errorMessage +=
				". The bot needs to be added to this channel. Use /invite @YourBot in the channel.";
		} else if (data.error === "invalid_auth") {
			errorMessage +=
				". The Slack token is invalid or expired. Please re-configure the Slack integration.";
		}

		throw new Error(errorMessage);
	}

	logger.info("[TemplateInstance] Slack API success", {
		method,
		hasMessages: Array.isArray(data.messages),
		messageCount: data.messages?.length || 0,
	});

	return data;
}

/**
 * Fetch data from GitHub API
 */
async function fetchGitHubData(
	token: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const baseUrl = "https://api.github.com";

	// Map tool names to GitHub API endpoints
	let endpoint: string;
	const method = "GET";

	switch (toolName) {
		case "github_list_repos":
			endpoint = args.org ? `/orgs/${args.org}/repos` : "/user/repos";
			break;
		case "github_list_prs":
			endpoint = `/repos/${args.owner}/${args.repo}/pulls`;
			break;
		case "github_list_issues":
			endpoint = `/repos/${args.owner}/${args.repo}/issues`;
			break;
		case "github_get_commits":
			endpoint = `/repos/${args.owner}/${args.repo}/commits`;
			break;
		case "github_search_code":
			endpoint = `/search/code?q=${encodeURIComponent(String(args.query || ""))}`;
			break;
		default:
			throw new Error(`Unknown GitHub tool: ${toolName}`);
	}

	const response = await fetch(`${baseUrl}${endpoint}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	if (!response.ok) {
		throw new Error(
			`GitHub API error: ${response.status} ${response.statusText}`,
		);
	}

	return await response.json();
}

/**
 * Fetch data from Linear API (GraphQL)
 */
async function fetchLinearData(
	token: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const baseUrl = "https://api.linear.app/graphql";

	// Map tool names to Linear GraphQL queries
	let query: string;
	let variables: Record<string, unknown> = {};

	switch (toolName) {
		case "linear_search_issues":
			query = `
				query SearchIssues($filter: IssueFilter) {
					issues(filter: $filter, first: 50) {
						nodes {
							id
							identifier
							title
							state { name }
							assignee { name }
							priority
							createdAt
							updatedAt
						}
					}
				}
			`;
			variables = { filter: args.filter || {} };
			break;
		case "linear_list_projects":
			query = `
				query ListProjects {
					projects(first: 50) {
						nodes {
							id
							name
							state
							progress
							targetDate
						}
					}
				}
			`;
			break;
		default:
			throw new Error(`Unknown Linear tool: ${toolName}`);
	}

	const response = await fetch(baseUrl, {
		method: "POST",
		headers: {
			Authorization: token,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});

	if (!response.ok) {
		throw new Error(
			`Linear API error: ${response.status} ${response.statusText}`,
		);
	}

	const data = await response.json();

	if (data.errors) {
		throw new Error(
			`Linear API error: ${data.errors.map((e: { message: string }) => e.message).join(", ")}`,
		);
	}

	return data.data;
}

/**
 * Fetch data from Jira API
 */
async function fetchJiraData(
	token: string,
	toolName: string,
	args: Record<string, unknown>,
	baseUrl?: string,
): Promise<unknown> {
	if (!baseUrl) {
		throw new Error("Jira integration requires baseUrl in config");
	}

	let endpoint: string;

	switch (toolName) {
		case "jira_search_issues":
			endpoint = `/rest/api/3/search?jql=${encodeURIComponent(String(args.jql || ""))}`;
			break;
		case "jira_get_issue":
			endpoint = `/rest/api/3/issue/${args.issueKey}`;
			break;
		case "jira_list_projects":
			endpoint = "/rest/api/3/project";
			break;
		default:
			throw new Error(`Unknown Jira tool: ${toolName}`);
	}

	const response = await fetch(`${baseUrl}${endpoint}`, {
		headers: {
			Authorization: `Basic ${token}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Jira API error: ${response.status} ${response.statusText}`,
		);
	}

	return await response.json();
}

/**
 * Dynamically discover available connection for a service type
 *
 * This function implements "smart" connection discovery:
 * 1. First checks for MCP server config with matching key (e.g., "slack")
 * 2. Then checks for Workflow Integration with matching provider (e.g., "SLACK")
 * 3. Uses whichever is available first
 *
 * This allows templates to specify WHAT to connect to (Slack, GitHub, etc.)
 * and the system automatically finds HOW the user connected (MCP or Integration)
 */
async function discoverConnection(
	serviceKey: string,
	userId: string,
	organizationId?: string,
	explicitMcpConfigId?: string,
	explicitIntegrationId?: string,
): Promise<DiscoveredConnection> {
	logger.info("[TemplateInstance] Discovering connection", {
		serviceKey,
		userId,
		organizationId,
		explicitMcpConfigId,
		explicitIntegrationId,
	});

	// If explicit MCP config binding is provided, validate it exists before using
	if (explicitMcpConfigId) {
		try {
			// Use internal version - authorization was already done at API layer before starting workflow
			const mcpConfig =
				await getMcpConfigByIdInternal(explicitMcpConfigId);
			if (mcpConfig) {
				logger.info(
					"[TemplateInstance] Using validated explicit MCP config",
					{
						serviceKey,
						configId: explicitMcpConfigId,
						mcpServerKey: mcpConfig.mcpServer?.key,
					},
				);
				return { type: "mcp", mcpConfigId: explicitMcpConfigId };
			}
			logger.warn(
				"[TemplateInstance] Explicit MCP config ID not found, falling back to discovery",
				{
					serviceKey,
					explicitMcpConfigId,
				},
			);
		} catch (error) {
			logger.warn(
				"[TemplateInstance] Failed to validate explicit MCP config, falling back to discovery",
				{
					serviceKey,
					explicitMcpConfigId,
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
			);
		}
	}

	// If explicit integration binding is provided, use it
	if (explicitIntegrationId) {
		return { type: "integration", integrationId: explicitIntegrationId };
	}

	// Step 1: Check for MCP server config with matching key
	try {
		// Get the MCP server definition by key
		const mcpServer = await getMcpServerByKey(serviceKey, {
			userId,
			organizationId,
			includeSystem: true,
		});

		if (mcpServer) {
			// Check if user has a config for this server
			// Per-user-within-org: each user has their own MCP configs
			const tenantConfigs = await listMcpConfigsForTenant({
				userId,
				organizationId,
			});

			const matchingConfig = tenantConfigs.find(
				(cfg) => cfg.mcpServer.key === serviceKey && cfg.enabled,
			);

			if (matchingConfig) {
				logger.info("[TemplateInstance] Found MCP config for service", {
					serviceKey,
					configId: matchingConfig.id,
					mcpServerName: matchingConfig.mcpServer.name,
				});
				return { type: "mcp", mcpConfigId: matchingConfig.id };
			}
		}
	} catch (error) {
		logger.warn("[TemplateInstance] MCP config lookup failed", {
			serviceKey,
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}

	// Step 2: Check for Workflow Integration with matching provider
	try {
		const providerName = serviceKey.toUpperCase() as any;
		const credentials = await fetchCredentialsByProvider(
			providerName,
			userId,
			organizationId,
		);

		// Check if credentials exist AND have valid keys
		const expectedKey = `${providerName}_API_KEY`;
		const altKey = `${providerName}_ACCESS_TOKEN`;
		const tokenKey = `${providerName}_TOKEN`;

		const hasValidCredentials =
			credentials &&
			Object.keys(credentials).length > 0 &&
			(credentials[expectedKey] ||
				credentials[altKey] ||
				credentials[tokenKey]);

		if (hasValidCredentials) {
			logger.info(
				"[TemplateInstance] Found Workflow Integration for service",
				{
					serviceKey,
					provider: providerName,
					credentialKeys: Object.keys(credentials),
				},
			);
			return { type: "integration", provider: providerName };
		}
	} catch (error) {
		logger.warn("[TemplateInstance] Integration lookup failed", {
			serviceKey,
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}

	// No connection found
	logger.warn("[TemplateInstance] No connection found for service", {
		serviceKey,
	});
	return { type: "none" };
}

export async function fetchInstanceDataSources(input: {
	dataSources: Array<{
		type: string;
		id: string;
		config?: Record<string, unknown>;
	}>;
	connections: {
		mcpConfigs?: Record<string, string>; // key -> configId bindings (explicit)
		integrations?: Record<string, string>; // key -> integrationId bindings (explicit)
		resourceBindings?: Record<
			string,
			{ resourceId: string; resourceName: string; resourceType: string }
		>;
		workspaceIds?: string[];
		agentIds?: string[];
	};
	userId: string;
	organizationId?: string;
	parameters?: Record<string, unknown>;
	dateRange?: {
		start: string;
		end: string;
		period?: string;
	};
}): Promise<DataSourceResult[]> {
	const results: DataSourceResult[] = [];

	for (const source of input.dataSources) {
		try {
			let data: unknown = null;

			switch (source.type) {
				case "mcp": {
					const toolName = source.config?.toolName as string;
					const mcpServerKey = source.config?.mcpServerKey as string;

					logger.info(
						"[TemplateInstance] Processing MCP data source",
						{
							sourceId: source.id,
							toolName,
							mcpServerKey,
						},
					);

					if (!toolName) {
						throw new Error(
							`MCP data source ${source.id} missing toolName`,
						);
					}

					if (!mcpServerKey) {
						throw new Error(
							`MCP data source ${source.id} missing mcpServerKey`,
						);
					}

					// Use dynamic connection discovery
					// This automatically finds the best available connection method:
					// 1. Explicit binding from instance.connections (if provided)
					// 2. MCP server config with matching key
					// 3. Workflow Integration with matching provider
					const explicitMcpConfigId =
						input.connections.mcpConfigs?.[mcpServerKey];
					const explicitIntegrationId =
						input.connections.integrations?.[mcpServerKey];

					const discoveredConnection = await discoverConnection(
						mcpServerKey,
						input.userId,
						input.organizationId,
						explicitMcpConfigId,
						explicitIntegrationId,
					);

					logger.info(
						"[TemplateInstance] Connection discovery result",
						{
							mcpServerKey,
							discoveredType: discoveredConnection.type,
							mcpConfigId: discoveredConnection.mcpConfigId,
							integrationId: discoveredConnection.integrationId,
							provider: discoveredConnection.provider,
						},
					);

					if (discoveredConnection.type === "none") {
						throw new Error(
							`No connection found for "${mcpServerKey}". ` +
								"Please configure either:\n" +
								`• An MCP server for ${mcpServerKey} in Settings > MCP Servers, OR\n` +
								`• A ${mcpServerKey.toUpperCase()} integration in Settings > Integrations`,
						);
					}

					// Get resource binding for this MCP server key (e.g., selected Slack channel)
					const resourceBinding = mcpServerKey
						? input.connections.resourceBindings?.[mcpServerKey]
						: undefined;

					// Build resource args from resource binding
					// Maps resourceType to parameter name: channel -> channelId, board -> boardId, etc.
					const resourceArgs: Record<string, string> = {};
					if (
						resourceBinding?.resourceId &&
						resourceBinding?.resourceType
					) {
						const resourceType =
							resourceBinding.resourceType.toLowerCase();
						// Add resourceId as {resourceType}Id (e.g., channelId, boardId, repoId)
						resourceArgs[`${resourceType}Id`] =
							resourceBinding.resourceId;
						// Also add as just the resource type for APIs that expect it
						resourceArgs[resourceType] = resourceBinding.resourceId;
						// Add resource name for reference
						if (resourceBinding.resourceName) {
							resourceArgs[`${resourceType}Name`] =
								resourceBinding.resourceName;
						}
					}

					const toolArgs = {
						...((source.config?.args as Record<string, unknown>) ||
							{}),
						...(input.dateRange
							? {
									startDate: input.dateRange.start,
									endDate: input.dateRange.end,
								}
							: {}),
						...resourceArgs, // Add resource binding args
						...input.parameters, // Parameters can override resource binding
					};

					logger.info(
						"[TemplateInstance] Built toolArgs for data source",
						{
							sourceId: source.id,
							toolName,
							templateArgs: source.config?.args,
							resourceBinding,
							resourceArgs,
							inputParameters: input.parameters,
							mergedToolArgs: toolArgs,
						},
					);

					// Route to the appropriate data fetching method based on discovered connection
					if (discoveredConnection.type === "integration") {
						// Use Workflow Integration for data fetching
						data = await fetchDataViaProviderOrIntegration({
							mcpServerKey,
							integrationId: discoveredConnection.integrationId,
							useProviderCredentials:
								!discoveredConnection.integrationId, // Use provider lookup if no explicit ID
							toolName,
							toolArgs,
							userId: input.userId,
							organizationId: input.organizationId,
						});
					} else if (discoveredConnection.type === "mcp") {
						// Use MCP tool execution
						const mcpResult = await executeMcpTool({
							toolName,
							args: toolArgs,
							userId: input.userId,
							organizationId: input.organizationId,
							mcpConfigId: discoveredConnection.mcpConfigId,
						});

						if (mcpResult.success) {
							data = mcpResult.output;
						} else {
							throw new Error(
								`MCP tool execution failed: ${mcpResult.output}`,
							);
						}
					}
					break;
				}

				case "api": {
					const url = source.config?.url as string;
					const method = (source.config?.method as string) || "GET";
					const headers =
						(source.config?.headers as Record<string, string>) ||
						{};

					if (!url) {
						throw new Error(
							`API data source ${source.id} missing url`,
						);
					}

					// Replace parameter placeholders in URL
					let resolvedUrl = url;
					if (input.parameters) {
						for (const [key, value] of Object.entries(
							input.parameters,
						)) {
							resolvedUrl = resolvedUrl.replace(
								`{{${key}}}`,
								String(value),
							);
						}
					}

					const response = await fetch(resolvedUrl, {
						method,
						headers: {
							"Content-Type": "application/json",
							...headers,
						},
						...(method !== "GET" && source.config?.body
							? { body: JSON.stringify(source.config.body) }
							: {}),
					});

					if (!response.ok) {
						throw new Error(
							`API request failed: ${response.status} ${response.statusText}`,
						);
					}

					data = await response.json();
					break;
				}

				case "workspace": {
					const workspaceId =
						(source.config?.workspaceId as string) ||
						input.connections.workspaceIds?.[0];

					if (!workspaceId) {
						throw new Error(
							`Workspace data source ${source.id} missing workspaceId`,
						);
					}

					const { listWorkspaceDocuments } = await import(
						"@repo/database"
					);

					const search =
						(source.config?.search as string) ||
						(input.parameters?.search as string);
					const limit = (source.config?.limit as number) || 20;

					const result = await listWorkspaceDocuments({
						workspaceId,
						search,
						limit,
						status: "READY",
					});

					data = {
						workspaceId,
						search,
						documents: result.documents.map((doc: any) => ({
							id: doc.id,
							filename: doc.originalFilename || doc.filename,
							mimeType: doc.mimeType,
							size: doc.size,
						})),
						totalResults: result.total,
					};
					break;
				}

				case "user-input": {
					const inputKey =
						(source.config?.inputKey as string) || source.id;
					data = input.parameters?.[inputKey] || null;
					break;
				}

				default:
					logger.warn(
						`[TemplateInstance] Unknown data source type: ${source.type}`,
					);
					data = null;
			}

			results.push({
				sourceId: source.id,
				sourceType: source.type,
				data,
			});
		} catch (error) {
			logger.error(
				`[TemplateInstance] Failed to fetch data from source ${source.id}:`,
				error,
			);
			results.push({
				sourceId: source.id,
				sourceType: source.type,
				data: null,
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	return results;
}

// =============================================================================
// AI Analysis
// =============================================================================

export async function executeInstanceAiAnalysis(input: {
	aiAgents: Array<{
		agentId: string;
		task: string;
		outputVariable?: string;
	}>;
	dataContext: DataSourceResult[];
	enrichedSystemPrompt: string;
	userId: string;
	organizationId?: string;
	parameters?: Record<string, unknown>;
}): Promise<AiAnalysisResult[]> {
	const results: AiAnalysisResult[] = [];

	// Build context string from data sources (including errors for transparency)
	const successfulSources = input.dataContext
		.filter((d) => d.data && !d.error)
		.map(
			(d) =>
				`## Data from ${d.sourceId} (${d.sourceType}):\n${JSON.stringify(d.data, null, 2)}`,
		);

	const failedSources = input.dataContext
		.filter((d) => d.error)
		.map(
			(d) =>
				`## ⚠️ Failed to fetch data from ${d.sourceId} (${d.sourceType}):\nError: ${d.error}`,
		);

	const contextSummary = [...successfulSources, ...failedSources].join(
		"\n\n",
	);

	// Log data source status for debugging
	logger.info("[TemplateInstance] AI analysis context", {
		totalSources: input.dataContext.length,
		successfulSources: successfulSources.length,
		failedSources: failedSources.length,
		sourceDetails: input.dataContext.map((d) => ({
			sourceId: d.sourceId,
			hasData: !!d.data,
			error: d.error,
		})),
	});

	for (const agent of input.aiAgents) {
		try {
			// Use inline AI for "default" or "inline:" agents
			if (
				agent.agentId.startsWith("inline:") ||
				agent.agentId === "default"
			) {
				const output = await executeInlineAiTask({
					task: agent.task,
					context: contextSummary,
					systemPrompt: input.enrichedSystemPrompt,
					userId: input.userId,
					organizationId: input.organizationId,
					parameters: input.parameters,
				});

				results.push({
					agentId: agent.agentId,
					task: agent.task,
					output,
					outputVariable: agent.outputVariable,
				});
			} else {
				// For registered agents, use delegation
				const { delegateToAgent } = await import(
					"../orchestrator/delegation/delegate-to-agent"
				);

				const delegationResult = await delegateToAgent({
					agentId: agent.agentId,
					message: `${agent.task}\n\n## Context Data:\n${contextSummary}`,
					userId: input.userId,
					organizationId: input.organizationId,
					context: {
						templateContext: true,
						parameters: input.parameters,
					},
					delegationMode: "single-step",
				});

				if (delegationResult.status === "completed") {
					results.push({
						agentId: agent.agentId,
						task: agent.task,
						output: delegationResult.response,
						outputVariable: agent.outputVariable,
					});
				} else {
					results.push({
						agentId: agent.agentId,
						task: agent.task,
						output: "",
						error:
							delegationResult.response ||
							"Agent delegation failed",
					});
				}
			}
		} catch (error) {
			logger.error(
				`[TemplateInstance] Failed to execute AI agent ${agent.agentId}:`,
				error,
			);
			results.push({
				agentId: agent.agentId,
				task: agent.task,
				output: "",
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	return results;
}

async function executeInlineAiTask(input: {
	task: string;
	context: string;
	systemPrompt: string;
	userId: string;
	organizationId?: string;
	parameters?: Record<string, unknown>;
}): Promise<string> {
	// Use standard model selector from orchestrator (handles API key resolution internally)
	const model = await getAiModel(input.userId, input.organizationId, false);

	// Use Fabric AI enriched system prompt if available, otherwise use default
	const systemPrompt =
		input.systemPrompt ||
		`You are an AI assistant helping to generate reports and analyze data.
Be concise, accurate, and format your response in markdown when appropriate.`;

	const prompt = `## Task:
${input.task}

## Available Data:
${input.context}

${input.parameters ? `## Additional Parameters:\n${JSON.stringify(input.parameters, null, 2)}` : ""}

Please complete the task based on the available data.`;

	const result = await generateText({
		model,
		prompt,
		system: systemPrompt,
	});

	return result.text;
}

// =============================================================================
// Rendering
// =============================================================================

export async function renderInstanceReport(input: {
	instance: {
		name: string;
		description?: string | null;
	};
	template: {
		name: string;
		definition: unknown;
	};
	dataResults: DataSourceResult[];
	aiResults: AiAnalysisResult[];
	parameters?: Record<string, unknown>;
	dateRange?: {
		start: string;
		end: string;
		period?: string;
	};
	outputFormat?: string;
	isPartial?: boolean;
}): Promise<RenderedReport> {
	const {
		instance,
		template,
		dataResults,
		aiResults,
		parameters,
		dateRange,
		outputFormat = "MARKDOWN",
		isPartial = false,
	} = input;

	const isHtmlFormat = outputFormat === "HTML" || outputFormat === "PDF";

	const definition = template.definition as {
		sections?: Array<{
			id: string;
			title: string;
			type: string;
			config?: Record<string, unknown>;
		}>;
	};

	const lines: string[] = [];

	if (isHtmlFormat) {
		// HTML rendering
		lines.push(`<h1>${escapeHtml(instance.name)}</h1>`);

		if (instance.description) {
			lines.push(`<p>${escapeHtml(instance.description)}</p>`);
		}

		lines.push(
			`<p class="report-meta"><em>Generated: ${new Date().toLocaleString()}</em></p>`,
		);

		if (dateRange) {
			lines.push(
				`<p class="report-meta"><em>Period: ${escapeHtml(dateRange.start)} to ${escapeHtml(dateRange.end)}</em></p>`,
			);
		}

		lines.push("<hr>");
	} else {
		// Markdown rendering
		lines.push(`# ${instance.name}`);
		lines.push("");

		if (instance.description) {
			lines.push(instance.description);
			lines.push("");
		}

		lines.push(`_Generated: ${new Date().toLocaleString()}_`);

		if (dateRange) {
			lines.push(`_Period: ${dateRange.start} to ${dateRange.end}_`);
		}

		lines.push("");
		lines.push("---");
		lines.push("");
	}

	if (isPartial) {
		if (isHtmlFormat) {
			lines.push(
				'<p class="report-partial-notice"><strong>⚠️ Partial data</strong> — generation was incomplete; some sections may be missing or based on a subset of the source.</p>',
			);
			lines.push("<hr>");
		} else {
			lines.push(
				"> ⚠️ **Partial data** — generation was incomplete; some sections may be missing or based on a subset of the source.",
			);
			lines.push("");
		}
	}

	// Render sections
	const sections = definition.sections || [];

	for (const section of sections) {
		if (isHtmlFormat) {
			lines.push(`<h2>${escapeHtml(section.title)}</h2>`);
		} else {
			lines.push(`## ${section.title}`);
			lines.push("");
		}

		switch (section.type) {
			case "text": {
				let content = (section.config?.template as string) || "";
				if (parameters) {
					for (const [key, value] of Object.entries(parameters)) {
						content = content.replace(
							new RegExp(`\\{\\{${key}\\}\\}`, "g"),
							String(value),
						);
					}
				}
				if (isHtmlFormat) {
					lines.push(`<p>${escapeHtml(content)}</p>`);
				} else {
					lines.push(content);
				}
				break;
			}

			case "table": {
				const sourceId = section.config?.dataSourceId as string;
				const data = dataResults.find(
					(r) => r.sourceId === sourceId,
				)?.data;

				if (data && Array.isArray(data) && data.length > 0) {
					const headers = Object.keys(data[0]);
					if (isHtmlFormat) {
						lines.push('<table class="data-table">');
						lines.push("<thead><tr>");
						for (const h of headers) {
							lines.push(`<th>${escapeHtml(h)}</th>`);
						}
						lines.push("</tr></thead>");
						lines.push("<tbody>");
						for (const row of data) {
							lines.push("<tr>");
							for (const h of headers) {
								lines.push(
									`<td>${escapeHtml(String(row[h] ?? ""))}</td>`,
								);
							}
							lines.push("</tr>");
						}
						lines.push("</tbody></table>");
					} else {
						lines.push(`| ${headers.join(" | ")} |`);
						lines.push(
							`| ${headers.map(() => "---").join(" | ")} |`,
						);
						for (const row of data) {
							lines.push(
								`| ${headers.map((h) => String(row[h] ?? "")).join(" | ")} |`,
							);
						}
					}
				} else if (isHtmlFormat) {
					lines.push("<p><em>No data available</em></p>");
				} else {
					lines.push("_No data available_");
				}
				break;
			}

			case "ai-generated": {
				const agentId = section.config?.agentId as string;
				const outputVariable = section.config?.outputVariable as string;

				const result = aiResults.find(
					(r) =>
						r.agentId === agentId ||
						r.outputVariable === outputVariable,
				);

				if (result) {
					if (result.error) {
						if (isHtmlFormat) {
							lines.push(
								`<p class="warning"><em>Error: ${escapeHtml(result.error)}</em></p>`,
							);
						} else {
							lines.push(`_Error: ${result.error}_`);
						}
					} else {
						// AI output is already in the correct format (HTML or markdown)
						lines.push(result.output);
					}
				} else if (isHtmlFormat) {
					lines.push("<p><em>AI analysis not available</em></p>");
				} else {
					lines.push("_AI analysis not available_");
				}
				break;
			}

			case "data": {
				const sourceId = section.config?.dataSourceId as string;
				const result = dataResults.find((r) => r.sourceId === sourceId);

				if (result?.data) {
					if (isHtmlFormat) {
						lines.push(
							`<pre><code>${escapeHtml(JSON.stringify(result.data, null, 2))}</code></pre>`,
						);
					} else {
						lines.push("```json");
						lines.push(JSON.stringify(result.data, null, 2));
						lines.push("```");
					}
				} else if (result?.error) {
					if (isHtmlFormat) {
						lines.push(
							`<p class="warning"><em>Error: ${escapeHtml(result.error)}</em></p>`,
						);
					} else {
						lines.push(`_Error: ${result.error}_`);
					}
				} else if (isHtmlFormat) {
					lines.push("<p><em>No data available</em></p>");
				} else {
					lines.push("_No data available_");
				}
				break;
			}

			default:
				if (isHtmlFormat) {
					lines.push(
						`<p><em>Unknown section type: ${escapeHtml(section.type)}</em></p>`,
					);
				} else {
					lines.push(`_Unknown section type: ${section.type}_`);
				}
		}

		lines.push("");
	}

	// Add unreferenced AI results (e.g., from default agent when no ai-generated sections exist)
	// Track which AI results were already used in sections
	const usedAgentIds = new Set<string>();
	const usedOutputVariables = new Set<string>();

	for (const section of sections) {
		if (section.type === "ai-generated") {
			if (section.config?.agentId) {
				usedAgentIds.add(section.config.agentId as string);
			}
			if (section.config?.outputVariable) {
				usedOutputVariables.add(
					section.config.outputVariable as string,
				);
			}
		}
	}

	// Find AI results that weren't used in any section
	const unreferencedResults = aiResults.filter(
		(r) =>
			!usedAgentIds.has(r.agentId) &&
			(!r.outputVariable || !usedOutputVariables.has(r.outputVariable)),
	);

	// Append unreferenced AI results to the report
	for (const result of unreferencedResults) {
		if (result.output && !result.error) {
			if (isHtmlFormat) {
				lines.push("<section>");
				lines.push("<h2>Analysis</h2>");
				lines.push(result.output);
				lines.push("</section>");
			} else {
				lines.push("## Analysis");
				lines.push("");
				lines.push(result.output);
				lines.push("");
			}
		}
	}

	// Cap the rendered output so a data-heavy template cannot exceed Temporal's
	// activity-result blob limit. The rendered
	// string is the return of this activity AND the input of storeInstanceArtifact
	// — both travel through the event history — so bounding it here protects both.
	const capped = capRenderedReport(lines.join("\n"), {
		isHtml: isHtmlFormat,
	});
	if (capped.truncated) {
		logger.warn("[DataFetching] Rendered report exceeded payload budget", {
			instance: instance.name,
			originalBytes: capped.originalBytes,
			finalBytes: capped.finalBytes,
		});
	}

	return {
		markdown: capped.text,
		title: instance.name,
		generatedAt: new Date().toISOString(),
	};
}

/** Escape HTML special characters to prevent XSS */
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

// =============================================================================
// Artifact Storage
// =============================================================================

export async function storeInstanceArtifact(input: {
	executionId: string;
	userId: string;
	organizationId?: string;
	name: string;
	description?: string;
	artifactType: "MARKDOWN" | "PDF" | "HTML" | "CSV" | "JSON";
	content: string;
	mimeType: string;
	metadata?: Prisma.InputJsonValue;
}): Promise<{ id: string }> {
	const artifact = await createTemplateInstanceArtifact({
		executionId: input.executionId,
		userId: input.userId,
		organizationId: input.organizationId,
		name: input.name,
		description: input.description,
		artifactType: input.artifactType,
		content: input.content,
		mimeType: input.mimeType,
		size: Buffer.byteLength(input.content, "utf-8"),
		metadata: input.metadata,
	});

	return { id: artifact.id };
}

/**
 * Index an instance artifact for RAG retrieval
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function indexInstanceArtifactForRag(input: {
	artifactId: string;
	content: string;
	chunkSize?: number;
	chunkOverlap?: number;
	// Tenant isolation fields
	userId: string;
	organizationId?: string;
}): Promise<{ chunkCount: number }> {
	const {
		artifactId,
		content,
		chunkSize = 1000,
		chunkOverlap = 200,
		userId,
		organizationId,
	} = input;

	const chunks: string[] = [];
	let start = 0;

	while (start < content.length) {
		const end = Math.min(start + chunkSize, content.length);
		chunks.push(content.slice(start, end));
		start = end - chunkOverlap;
		if (start >= content.length - chunkOverlap) {
			break;
		}
	}

	await createTemplateInstanceArtifactChunks(
		chunks.map((chunk, index) => ({
			artifactId,
			content: chunk,
			chunkIndex: index,
		})),
		{
			userId,
			organizationId,
		},
	);

	await updateTemplateInstanceArtifactRag({
		id: artifactId,
		qdrantId: `template_instance_artifact_${artifactId}`,
		chunkCount: chunks.length,
	});

	return { chunkCount: chunks.length };
}

// Import agent loop for data gathering
import {
	executeAgentDataGatheringLoop,
	resolveReportConnections,
} from "./report-agent-loop";
// Report-run completion/failure EMAIL activity. Thin wrapper over
// the @repo/database claim helper + @repo/mail send; registered below so the
// workflow can proxy it via `typeof templateInstanceActivities`.
import { sendReportExecutionEmail } from "./send-report-execution-email";

// =============================================================================
// Report Template Skills
// =============================================================================

export async function fetchReportTemplateSkills(input: {
	templateId: string;
}): Promise<Array<{ name: string; content: string }>> {
	const { listReportTemplateSkills } = await import("@repo/database");
	const templateSkills = await listReportTemplateSkills(input.templateId);
	return templateSkills
		.filter((ts) => ts.skill.isPublished)
		.map((ts) => ({ name: ts.skill.name, content: ts.skill.content }));
}

// Export all activities
export const templateInstanceActivities = {
	fetchTemplateInstanceWithTemplate,
	updateInstanceExecutionStatus,
	fetchInstanceDataSources,
	executeInstanceAiAnalysis,
	renderInstanceReport,
	storeInstanceArtifact,
	indexInstanceArtifactForRag,
	executeAgentDataGatheringLoop,
	resolveReportConnections,
	fetchReportTemplateSkills,
	emitReportExecutionNotification,
	sendReportExecutionEmail,
};

// Re-export the report-execution notification activity. The
// implementation lives in @repo/database (shared, unit-tested); the workflow
// proxies it via `typeof templateInstanceActivities`.
export { emitReportExecutionNotification };

// Re-export the report-execution EMAIL activity. Implementation
// lives in ./send-report-execution-email; the workflow proxies it via
// `typeof templateInstanceActivities`.
export { sendReportExecutionEmail };

export type {
	AgentLoopResult,
	ExecuteAgentLoopInput,
	InstanceContext,
} from "./report-agent-loop";
// Re-export agent loop types and function
export {
	executeAgentDataGatheringLoop,
	resolveReportConnections,
} from "./report-agent-loop";
