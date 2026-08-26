/**
 * AI Execution Activity
 *
 * Handles the main AI chat execution with tools.
 *
 * LAZY MCP LOADING:
 * This activity implements smart MCP tool loading:
 * 1. Analyzes the user's message to determine if MCP tools are likely needed
 * 2. If not needed, skips MCP connections entirely (fast path)
 * 3. If needed, only connects to servers that match the user's intent
 *
 * This dramatically reduces latency for simple queries.
 */

import { closeMcpClientSafe, getMcpClient } from "@repo/agent-core/backend";
import {
	convertToModelMessages,
	type DynamicTaskComplexity,
	enhancePromptWithFabric,
	getAIModelWithMetadata,
	getCurrentDateContext,
	logModelUsageAsync,
	stepCountIs,
	streamText,
	tool,
} from "@repo/ai";
import {
	buildSkillsSystemBlock,
	createSkillTools,
	listAvailableSkills,
	type SkillSummary,
} from "@repo/ai/skills";
import {
	ensureSensitiveOperationAuthority,
	getWorkflowById,
	listWorkflows,
	loadProjectDatabricksKnowledgeBinding,
} from "@repo/database";
import type { McpClientType } from "@repo/mcp";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import type {
	ActivityHeartbeatDetails,
	DirectChatToolCall,
	DirectChatWorkflowInput,
	DirectChatWorkflowOutput,
} from "../../types";
import {
	classifyToolAccessLevel,
	resolveProviderKey,
} from "../orchestrator/execution/authority-gate";
import { parsePartialJson } from "../orchestrator/execution/context/partial-json";
import {
	DEFAULT_MCP_TOOL_TIMEOUT_MS,
	runWithTimeout,
} from "../orchestrator/execution/mcp-call-timeout";
import { jsonSchemaToZod } from "../orchestrator/utils";
import {
	buildDatabricksKnowledgeToolDefinition,
	databricksKnowledgeToolName,
	executeDatabricksKnowledgeSearchSafe,
	loadAgentDatabricksBindings,
	mergeDatabricksBindings,
} from "../shared/databricks-knowledge";
import { guardToolWriteForReadOnly } from "../shared/read-only-gate";
import {
	buildProviderOptions,
	resolveOutputTokenBudget,
} from "./build-provider-options";
import { createBuiltInTools } from "./built-in-tools";
import { decideForcedToolChoice } from "./decide-forced-tool-choice";
import type { McpToolInfo } from "./mcp-tools";
import { extractReasoningText } from "./reasoning-stream";
import { extractStreamErrorMessage } from "./stream-error";
import { resolveStreamOutcome } from "./stream-outcome";
import { capToolSet, validateMcpToolSet } from "./tool-payload-safety";

const logger = {
	info: (message: string, data?: Record<string, unknown>) =>
		console.log(`[DirectChat AI] ${message}`, data || ""),
	error: (message: string, error?: unknown) =>
		console.error(`[DirectChat AI] ${message}`, error),
	warn: (message: string, data?: Record<string, unknown>) =>
		console.warn(`[DirectChat AI] ${message}`, data || ""),
};

function detectRequestedFrameOutput(
	message: string,
): "frame" | "slideshow" | null {
	const lower = message.toLowerCase();
	const slideshowPatterns = [
		"slideshow",
		"slide deck",
		"slide-deck",
		"slides about",
		"create slides",
		"make slides",
		"presentation",
		"presentation deck",
		"deck about",
		"5-slide",
		"5 slide",
	];
	if (slideshowPatterns.some((pattern) => lower.includes(pattern))) {
		return "slideshow";
	}

	const framePatterns = [
		"create a frame",
		"make a frame",
		"build a frame",
		"interactive frame",
		"fabric frame",
		"wireframe",
		// Visualization / chart / dashboard
		"create a visualization",
		"make a visualization",
		"generate a visualization",
		"build a visualization",
		"data visualization",
		"interactive visualization",
		"visualize",
		"create a chart",
		"make a chart",
		"generate a chart",
		"build a chart",
		"interactive chart",
		"create a graph",
		"make a graph",
		"interactive graph",
		"create a dashboard",
		"make a dashboard",
		"build a dashboard",
		"interactive dashboard",
	];
	if (framePatterns.some((pattern) => lower.includes(pattern))) {
		return "frame";
	}

	return null;
}

function isExecutableToolDefinition(toolDef: unknown): toolDef is {
	description?: string;
	inputSchema: Parameters<typeof tool>[0]["inputSchema"];
	execute: (args: Record<string, unknown>) => Promise<unknown>;
} {
	return !!(
		toolDef &&
		typeof toolDef === "object" &&
		"inputSchema" in toolDef &&
		"execute" in toolDef &&
		typeof (toolDef as { execute?: unknown }).execute === "function"
	);
}

function buildAuthorityRequiredResult(params: {
	providerKey: string;
	accessLevel: "READ" | "WRITE";
	serverName?: string;
	action?: "request_authority" | "approve_pending" | "upgrade_access_level";
	pendingSessionId?: string;
	reason?: string;
}) {
	const {
		providerKey,
		accessLevel,
		serverName,
		action,
		pendingSessionId,
		reason,
	} = params;
	return {
		error:
			`Runtime authority required for ${serverName || providerKey}. ` +
			(reason || "Approve the pending authority request and retry."),
		authorityRequired: true,
		providerKey,
		requiredAccessLevel: accessLevel,
		action,
		pendingSessionId,
		hint:
			action === "approve_pending"
				? `Approve pending runtime authority${pendingSessionId ? ` (session ${pendingSessionId})` : ""} in the Fabric UI, then retry.`
				: `Approve runtime authority for ${providerKey} (${accessLevel}) in the Fabric UI, then retry.`,
	};
}

// =============================================================================
// MCP Tool Loading Intelligence
// =============================================================================

/**
 * Keywords that suggest the user wants to use external tools/services
 */
const TOOL_INTENT_KEYWORDS = [
	// Action verbs suggesting tool use
	"search",
	"find",
	"get",
	"fetch",
	"list",
	"show",
	"create",
	"add",
	"update",
	"delete",
	"remove",
	"send",
	"post",
	"scrape",
	"crawl",
	"query",
	// Visual / diagram creation
	"draw",
	"diagram",
	"visualize",
	"visualise",
	"sketch",
	"canvas",
	"chart",
	"graph",
	"render",
	"design",
	"wireframe",
	"flowchart",
	"architecture",
	// Service-specific keywords
	"web",
	"website",
	"url",
	"page",
	"firecrawl",
	"fizzy",
	"kanban",
	"board",
	"card",
	"task",
	"project",
	"slack",
	"email",
	"calendar",
	"document",
	"file",
	"database",
	"api",
	"data",
	// Explicit tool requests
	"tool",
	"tools",
	"use",
	"using",
	"via",
	"through",
	"with",
];

/**
 * Keywords that suggest a conversational/knowledge query (no tools needed)
 */
const CONVERSATIONAL_KEYWORDS = [
	"what is",
	"what are",
	"how do",
	"how does",
	"why",
	"explain",
	"tell me about",
	"describe",
	"define",
	"meaning",
	"difference between",
	"compare",
	"help me understand",
	"can you explain",
	"i don't understand",
];

/**
 * Analyze if the user's message likely needs MCP tools
 * Returns a score from 0-100 indicating tool need likelihood
 */
function analyzeToolNeed(
	message: string,
	mcpToolInfo: McpToolInfo[],
): {
	needsTools: boolean;
	confidence: number;
	matchedServers: McpToolInfo[];
	reason: string;
} {
	const messageLower = message.toLowerCase();
	const words = messageLower.split(/\s+/);

	// Check for conversational patterns first (strong negative signal)
	for (const pattern of CONVERSATIONAL_KEYWORDS) {
		if (messageLower.includes(pattern)) {
			return {
				needsTools: false,
				confidence: 80,
				matchedServers: [],
				reason: `Conversational query detected: "${pattern}"`,
			};
		}
	}

	// Check for tool intent keywords
	let toolScore = 0;
	const matchedKeywords: string[] = [];

	for (const keyword of TOOL_INTENT_KEYWORDS) {
		if (messageLower.includes(keyword)) {
			toolScore += 15;
			matchedKeywords.push(keyword);
		}
	}

	// Check for server name matches
	const matchedServers: McpToolInfo[] = [];

	for (const server of mcpToolInfo) {
		const serverNameLower = server.serverName.toLowerCase();
		const configNameLower = server.configName.toLowerCase();

		// Check if server name appears in message
		if (
			messageLower.includes(serverNameLower) ||
			messageLower.includes(configNameLower)
		) {
			matchedServers.push(server);
			toolScore += 40; // Strong signal
			continue;
		}

		// Check for keyword overlap with server name parts
		const serverParts = serverNameLower
			.split(/[\s_-]+/)
			.filter((p) => p.length > 2);
		for (const part of serverParts) {
			if (words.includes(part)) {
				matchedServers.push(server);
				toolScore += 25;
				break;
			}
		}
	}

	// Cap the score at 100
	const confidence = Math.min(toolScore, 100);
	const needsTools = confidence >= 30; // Threshold for tool loading

	let reason: string;
	if (matchedServers.length > 0) {
		reason = `Matched servers: ${matchedServers.map((s) => s.serverName).join(", ")}`;
	} else if (matchedKeywords.length > 0) {
		reason = `Tool keywords detected: ${matchedKeywords.slice(0, 3).join(", ")}`;
	} else {
		reason = "No tool intent detected";
	}

	return { needsTools, confidence, matchedServers, reason };
}

/**
 * Load MCP tools from specific servers only
 */
async function loadMcpToolsFromServers(
	servers: McpToolInfo[],
	userId: string,
	organizationId?: string,
): Promise<{
	tools: Record<string, unknown>;
	toolToServerMap: Record<
		string,
		{
			configId: string;
			serverName: string;
			resourceUri?: string;
			originalName: string;
		}
	>;
	clients: McpClientType[];
}> {
	const tools: Record<string, unknown> = {};
	const toolToServerMap: Record<
		string,
		{
			configId: string;
			serverName: string;
			resourceUri?: string;
			originalName: string;
		}
	> = {};
	const clients: McpClientType[] = [];

	for (const server of servers) {
		try {
			const result = await getMcpClient(
				server.configId,
				userId,
				organizationId,
			);
			if (result) {
				clients.push(result.client);
				const serverTools = await result.client.tools();

				for (const [toolName, toolDef] of Object.entries(serverTools)) {
					const prefixedName = `${server.serverName.toLowerCase().replace(/\s+/g, "_")}_${toolName}`;
					tools[prefixedName] = toolDef;
					// Capture MCP App resourceUri from tool _meta if present
					const resourceUri = (
						toolDef as { _meta?: { ui?: { resourceUri?: string } } }
					)._meta?.ui?.resourceUri;
					toolToServerMap[prefixedName] = {
						configId: server.configId,
						serverName: server.serverName,
						resourceUri,
						originalName: toolName,
					};
				}

				logger.info(`Loaded tools from ${server.serverName}`, {
					count: Object.keys(serverTools).length,
				});
			}
		} catch (error) {
			logger.error(`Failed to connect to ${server.serverName}`, error);
		}
	}

	return { tools, toolToServerMap, clients };
}

/**
 * Map reasoning mode to task type for dynamic model selection
 */
function mapReasoningModeToTaskType(
	reasoningMode: "lite" | "balanced" | "pro",
	hasTools: boolean,
): "SIMPLE" | "COMPLEX" | "REASONING" | "TOOL_CALLING" {
	if (hasTools) {
		return "TOOL_CALLING";
	}
	switch (reasoningMode) {
		case "lite":
			return "SIMPLE";
		case "balanced":
			return "COMPLEX";
		case "pro":
			return "REASONING";
		default:
			return "COMPLEX";
	}
}

/**
 * Map reasoning mode to complexity for dynamic model selection
 */
function mapReasoningModeToComplexity(
	reasoningMode: "lite" | "balanced" | "pro",
): DynamicTaskComplexity {
	switch (reasoningMode) {
		case "lite":
			return "simple";
		case "balanced":
			return "medium";
		case "pro":
			return "complex";
		default:
			return "medium";
	}
}

/**
 * Create workflow tools for AI interaction
 */
function createWorkflowTools(
	userId: string,
	organizationId?: string,
): Record<string, unknown> {
	const listWorkflowsSchema = z.object({
		query: z
			.string()
			.describe("Optional search query to filter workflows by name."),
	});

	const getWorkflowDetailsSchema = z.object({
		workflowId: z
			.string()
			.describe("The ID of the workflow to get details for"),
	});

	const executeWorkflowSchema = z.object({
		workflowId: z.string().describe("The ID of the workflow to execute"),
	});

	return {
		list_workflows: tool({
			description: "List all workflows belonging to the user.",
			inputSchema: listWorkflowsSchema as any,
			execute: async (params: { query?: string }) => {
				try {
					const result = await listWorkflows({
						userId,
						organizationId,
						search: params.query,
						limit: 100,
						offset: 0,
					});

					if (result.workflows.length === 0) {
						return {
							message: "No workflows found.",
							workflows: [],
						};
					}

					return {
						count: result.workflows.length,
						workflows: result.workflows.map((w) => ({
							id: w.id,
							name: w.name,
							description: w.description,
							status: w.status,
							triggerType: w.triggerType,
						})),
					};
				} catch (error) {
					return {
						error: `Failed to list workflows: ${error instanceof Error ? error.message : "Unknown error"}`,
					};
				}
			},
		}),
		get_workflow_details: tool({
			description:
				"Get detailed information about a specific workflow by ID.",
			inputSchema: getWorkflowDetailsSchema as any,
			execute: async (params: { workflowId: string }) => {
				try {
					const workflow = await getWorkflowById(
						params.workflowId,
						userId,
						organizationId,
					);

					if (!workflow) {
						return {
							error: `Workflow with ID ${params.workflowId} not found.`,
						};
					}

					return {
						id: workflow.id,
						name: workflow.name,
						description: workflow.description,
						status: workflow.status,
						triggerType: workflow.triggerType,
						nodes: workflow.nodes,
						edges: workflow.edges,
						variables: workflow.variables,
						createdAt: workflow.createdAt,
						updatedAt: workflow.updatedAt,
					};
				} catch (error) {
					return {
						error: `Failed to get workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
					};
				}
			},
		}),
		execute_workflow: tool({
			description:
				"Request to execute a workflow. Returns confirmation request.",
			inputSchema: executeWorkflowSchema as any,
			execute: async (params: { workflowId: string }) => {
				try {
					const workflow = await getWorkflowById(
						params.workflowId,
						userId,
						organizationId,
					);

					if (!workflow) {
						return {
							error: `Workflow with ID ${params.workflowId} not found.`,
						};
					}

					if (workflow.triggerType !== "MANUAL") {
						return {
							error: `Workflow "${workflow.name}" cannot be executed manually.`,
							triggerType: workflow.triggerType,
						};
					}

					return {
						requiresConfirmation: true,
						workflowId: workflow.id,
						workflowName: workflow.name,
						description: workflow.description,
						message: `Ready to execute workflow "${workflow.name}". Please confirm to proceed.`,
					};
				} catch (error) {
					return {
						error: `Failed to execute workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
					};
				}
			},
		}),
	};
}

/**
 * Execute the AI interaction with tools
 */
export async function executeDirectChatActivity(
	input: DirectChatWorkflowInput,
	mcpToolInfo: McpToolInfo[],
	memoryContext: string,
	toolSuggestionContext: string,
): Promise<DirectChatWorkflowOutput> {
	const startTime = Date.now();
	let streamErrorMessage: string | undefined;
	let streamFinishReason: string | undefined;
	const {
		executionId,
		message,
		history,
		instanceId,
		userId,
		organizationId,
		reasoningMode,
		ragContext,
		enabledFabricToolIds,
		enabledMcpConfigIds,
		workspaceIds,
		projectId,
	} = input;

	logger.info("Executing direct chat", {
		userId,
		reasoningMode,
		mcpServerCount: mcpToolInfo.length,
	});

	// ==========================================================================
	// SMART MCP TOOL LOADING: Only connect to servers that are likely needed
	// ==========================================================================
	let mcpTools: Record<string, unknown> = {};
	let toolToServerMap: Record<
		string,
		{
			configId: string;
			serverName: string;
			resourceUri?: string;
			originalName: string;
		}
	> = {};
	let mcpClients: McpClientType[] = [];

	// Analyze if the user's message needs MCP tools
	const toolAnalysis = analyzeToolNeed(message, mcpToolInfo);

	logger.info("Tool need analysis", {
		needsTools: toolAnalysis.needsTools,
		confidence: toolAnalysis.confidence,
		matchedServers: toolAnalysis.matchedServers.map((s) => s.serverName),
		reason: toolAnalysis.reason,
	});

	// `analyzeToolNeed` is a keyword heuristic, and it decides on the wording of
	// the message alone — "explain…", "what is…" and friends return
	// `needsTools: false` outright, and a single tool-intent keyword scores
	// below its threshold. When the user has explicitly attached servers for
	// this conversation, that guess must not overrule them: the request said
	// which servers to use, the deck showed them as active, and the model was
	// then told "No tools connected. Suggest the user connect tools in
	// Settings." — which is exactly what it went on to tell the user.
	const shouldForceLoadAttachedMcpTools =
		Boolean(instanceId) ||
		(Array.isArray(enabledMcpConfigIds) && enabledMcpConfigIds.length > 0);

	if (
		mcpToolInfo.length > 0 &&
		(shouldForceLoadAttachedMcpTools || toolAnalysis.needsTools)
	) {
		// Determine which servers to load
		const serversToLoad =
			!shouldForceLoadAttachedMcpTools &&
			toolAnalysis.matchedServers.length > 0
				? toolAnalysis.matchedServers
				: mcpToolInfo; // Fallback to all if keywords matched but no specific server

		logger.info("Loading MCP tools from selected servers", {
			serverCount: serversToLoad.length,
			servers: serversToLoad.map((s) => s.serverName),
			totalAvailable: mcpToolInfo.length,
		});

		const mcpResult = await loadMcpToolsFromServers(
			serversToLoad,
			userId,
			organizationId,
		);
		mcpTools = mcpResult.tools;
		toolToServerMap = mcpResult.toolToServerMap;
		mcpClients = mcpResult.clients;

		logger.info("MCP tools loaded (smart selection)", {
			toolCount: Object.keys(mcpTools).length,
			serverCount: serversToLoad.length,
		});

		// Wrap external tools so read-only calls stay autonomous, while the first
		// sensitive write creates a pending authority request for this execution.
		mcpTools = Object.fromEntries(
			Object.entries(mcpTools).map(([toolName, toolDef]) => {
				const serverInfo = toolToServerMap[toolName];
				if (!serverInfo || !isExecutableToolDefinition(toolDef)) {
					return [toolName, toolDef];
				}

				const providerKey = resolveProviderKey(
					serverInfo.serverName || serverInfo.configId,
				);
				const accessLevel = classifyToolAccessLevel(
					serverInfo.originalName,
				);

				return [
					toolName,
					tool({
						description: toolDef.description || toolName,
						inputSchema: toolDef.inputSchema,
						execute: async (args: Record<string, unknown>) => {
							// The ceiling covers the WHOLE call, not just
							// `toolDef.execute`: the read-only guard and the
							// authority check below both await the database,
							// and a hang in either leaves the tool card on
							// `Running` with nothing rendered — the same dead
							// turn, from a different await. A tool result (not
							// a throw) keeps the turn alive so the assistant
							// can say what happened.
							const call = (async () => {
								// Read-only mode: block external
								// write tools before the authority flow — the
								// structured error is relayed by the assistant in
								// its reply (no toast; this is the chat surface).
								const readOnlyBlock =
									await guardToolWriteForReadOnly(
										projectId,
										serverInfo.originalName,
									);
								if (readOnlyBlock) {
									logger.info(
										"Direct chat: write tool blocked — project in Read-only mode",
										{ toolName, projectId },
									);
									return readOnlyBlock;
								}
								const authority =
									await ensureSensitiveOperationAuthority({
										userId,
										organizationId,
										providerKey,
										accessLevel,
										providerType: "MCP",
										providerRefId: serverInfo.configId,
										providerDisplayName:
											serverInfo.serverName,
										runType: "AGENT_INSTANCE",
										runId: executionId,
										toolName: serverInfo.originalName,
									});

								if (!authority.authorized) {
									logger.info(
										"Direct chat: sensitive tool blocked pending authority",
										{
											toolName,
											providerKey,
											action: authority.action,
											pendingSessionId:
												authority.pendingSessionId,
										},
									);
									return buildAuthorityRequiredResult({
										providerKey,
										accessLevel,
										serverName: serverInfo.serverName,
										action: authority.action,
										pendingSessionId:
											authority.pendingSessionId,
										reason: authority.reason,
									});
								}

								return toolDef.execute(args);
							})();

							return runWithTimeout<unknown>(
								call,
								DEFAULT_MCP_TOOL_TIMEOUT_MS,
								() => {
									logger.warn(
										"Direct chat: MCP tool timed out",
										{
											toolName,
											serverName: serverInfo.serverName,
											timeoutMs:
												DEFAULT_MCP_TOOL_TIMEOUT_MS,
										},
									);
									return {
										error: `MCP tool "${serverInfo.originalName}" did not respond within ${
											DEFAULT_MCP_TOOL_TIMEOUT_MS / 1000
										}s. The server may be unreachable — retry, or turn it off under Chat tools.`,
									};
								},
							);
						},
					}),
				];
			}),
		);
	} else {
		logger.info("Skipping MCP tool loading (not needed for this query)", {
			reason: toolAnalysis.reason,
			availableServers: mcpToolInfo.length,
		});
	}

	// Create workflow tools
	const workflowTools = createWorkflowTools(userId, organizationId);

	// Create built-in tools (web search, etc.)
	const builtInTools = await createBuiltInTools({
		userId,
		organizationId,
		enabledFabricToolIds,
		workspaceIds,
		projectId,
	});
	const hasBuiltInWebSearch =
		"webSearch" in builtInTools || "fabric_web_search" in builtInTools;
	const requestedFrameOutput = detectRequestedFrameOutput(message);
	const hasFrameTool =
		"fabric_create_frame" in builtInTools ||
		"fabric_create_slideshow" in builtInTools;

	if (hasBuiltInWebSearch) {
		logger.info("Built-in web search tool enabled", { userId });
	}

	// Load in-scope skills (Anthropic Agent Skills) + their tools.
	// The skill system prompt block is injected below into fullSystemContext;
	// the three tools (list_skills, load_skill, read_skill_file) are merged
	// into allTools so the model can progressively disclose skill content.
	let availableSkills: SkillSummary[] = [];
	let skillTools: Record<string, unknown> = {};
	try {
		availableSkills = await listAvailableSkills({ userId, organizationId });
		if (availableSkills.length > 0) {
			skillTools = createSkillTools({ userId, organizationId });
			logger.info(`Skills in scope: ${availableSkills.length}`, {
				slugs: availableSkills.map((s) => s.slug).slice(0, 10),
			});
		}
	} catch (error) {
		logger.warn("Skill registry load failed", { error });
	}

	// Databricks knowledge tools come from TWO sources: the bound agent
	// instance's per-agent bindings (when an instanceId is present) AND the
	// project-level binding (when the chat operates in a project — with or
	// without a bound agent). Merged per integration so duplicate tool names
	// can't overwrite each other.
	let databricksKnowledgeTools: Record<string, unknown> = {};
	if (instanceId || projectId) {
		const [agentBindings, projectBinding] = await Promise.all([
			instanceId
				? loadAgentDatabricksBindings({
						instanceId,
						userId,
						organizationId,
					})
				: Promise.resolve([]),
			projectId
				? loadProjectDatabricksKnowledgeBinding({
						projectId,
						userId,
						organizationId,
					})
				: Promise.resolve(null),
		]);
		const bindings = mergeDatabricksBindings([
			...agentBindings,
			...(projectBinding ? [projectBinding] : []),
		]);
		databricksKnowledgeTools = Object.fromEntries(
			bindings.map((binding, index) => {
				const definition =
					buildDatabricksKnowledgeToolDefinition(binding);
				const toolName = databricksKnowledgeToolName(index);
				return [
					toolName,
					tool({
						description: definition.description,
						inputSchema: jsonSchemaToZod(definition.inputSchema),
						execute: async (args: Record<string, unknown>) =>
							executeDatabricksKnowledgeSearchSafe(
								binding,
								args,
								{ userId, organizationId },
							),
					} as unknown as Parameters<typeof tool>[0]),
				];
			}),
		);

		if (bindings.length > 0) {
			logger.info("Injected Databricks knowledge tools", {
				instanceId,
				projectId,
				hasProjectBinding: !!projectBinding,
				toolNames: Object.keys(databricksKnowledgeTools),
			});
		}
	}

	// Defensive (#1644): drop provider-incompatible MCP tool schemas and cap the
	// combined MCP payload so a large/invalid tool set can't fail the model call.
	// Built-in / workflow / skill tools are merged separately below and are not
	// subject to this cap.
	const MAX_MCP_TOOLS = 48;
	const MAX_MCP_SCHEMA_BYTES = 16_000;
	const mcpValidation = validateMcpToolSet(mcpTools);
	if (mcpValidation.dropped.length > 0) {
		logger.warn("Dropped invalid MCP tool schemas", {
			dropped: mcpValidation.dropped,
		});
	}
	const mcpCapped = capToolSet(mcpValidation.tools, {
		maxTools: MAX_MCP_TOOLS,
		maxTotalSchemaBytes: MAX_MCP_SCHEMA_BYTES,
		precomputedBytes: mcpValidation.sizes,
	});
	if (mcpCapped.dropped.length > 0) {
		logger.warn("Capped MCP tool payload over budget", {
			droppedCount: mcpCapped.dropped.length,
			dropped: mcpCapped.dropped,
			keptCount: Object.keys(mcpCapped.tools).length,
		});
	}
	mcpTools = mcpCapped.tools;

	// Combine all tools
	const allTools = {
		...builtInTools,
		...mcpTools,
		...workflowTools,
		...skillTools,
		...databricksKnowledgeTools,
	};
	const mcpToolNames = Object.keys(mcpTools);
	const hasTools = Object.keys(allTools).length > 0;
	const toolsEnabled = hasTools && !input.forceDisableTools;
	const hasMcpTools = mcpToolNames.length > 0;
	const mcpToolsEnabled = hasMcpTools && !input.forceDisableTools;
	const hasWorkflowTools = Object.keys(workflowTools).length > 0;

	// Dynamic model selection with centralized AI model access
	const taskType = mapReasoningModeToTaskType(
		reasoningMode as "lite" | "balanced" | "pro",
		toolsEnabled,
	);
	const complexity = mapReasoningModeToComplexity(
		reasoningMode as "lite" | "balanced" | "pro",
	);

	// Use centralized single entry point for AI model access.
	// `executeDirectChatActivity` is what `directChatWorkflow` runs, so THIS is
	// the model the user's chat answer is generated with — traced from
	// /api/agents/fabric-ai/stream rather than assumed (Fizzy #2230).
	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{
			taskType: taskType as any,
			complexity,
			requiresToolCalling: toolsEnabled,
			modelOverride: input.modelOverride,
		},
		{ userId, organizationId, featureKey: "chat-agent" },
	);

	logger.info("Dynamic model selected for direct chat", {
		modelName: metadata.modelString,
		selectionSource: metadata.selectionSource,
		provider: metadata.provider,
		taskType,
		reasoningMode,
		hasTools,
	});

	// Track usage (fire-and-forget)
	trackUsage();

	// Build system prompt
	// If a custom systemPrompt is provided, prepend it to the default instructions
	const defaultSystemInstructions = `You are Fabric Loom, an intelligent assistant that helps users accomplish tasks.

CAPABILITIES:
${toolsEnabled ? "- You have access to tools. Use them when they can help answer the user's question." : "- No tools connected. Suggest the user connect tools in Settings."}
${toolsEnabled && hasBuiltInWebSearch ? "- Web search is available via the webSearch tool. Use it for current information, news, research, and fact-checking." : ""}
${
	mcpToolsEnabled
		? `- External MCP tools are connected. You MUST call the relevant tool when it matches the user's request — do NOT describe how to use it, just call it directly.

AVAILABLE MCP TOOLS:
${mcpToolNames.map((name) => `  • ${name}`).join("\n")}

CRITICAL: When the user asks you to draw, create a diagram, visualize, sketch, or generate any visual content, call the appropriate MCP tool immediately. Never explain how to use the tool — call it.`
		: ""
}
${toolsEnabled && hasWorkflowTools ? "- User workflows can be listed and executed." : ""}

TOOL USAGE GUIDELINES:
- CAREFULLY read the tool's input schema to understand ALL available filter/query parameters
- When the user specifies filters, ALWAYS use the appropriate filter parameters
- Do NOT fetch ALL data and filter client-side - use server-side filtering
- Only fetch the minimum data needed to answer the user's question
- When an MCP tool is available that matches the user's request, call it — do not give text instructions instead
${
	toolsEnabled && hasBuiltInWebSearch
		? `
WEB SEARCH GUIDELINES:
- Use webSearch for questions about current events, recent information, or facts you're uncertain about
- Include the current year or "latest" in queries for up-to-date information
- After searching, cite sources using [Title](URL) format inline with the text
- Never put citations at the end - cite immediately after the relevant information
`
		: ""
}
RESPONSE GUIDELINES:
- Use markdown for formatting (tables, bullet points, code blocks)
- Be concise but complete
- Cite sources when using document context or web search results
${
	hasFrameTool && requestedFrameOutput
		? `
FRAME OUTPUT REQUIREMENT:
- The user explicitly asked for a ${requestedFrameOutput}.
- You MUST call ${requestedFrameOutput === "slideshow" ? "fabric_create_slideshow" : "fabric_create_frame"} instead of answering with plain-text slide/frame content.
- Do not outline the ${requestedFrameOutput} in prose first. Produce the first-class Fabric artifact directly.`
		: ""
}

${getCurrentDateContext()}`;

	// If caller provided a custom systemPrompt, prepend it before the default instructions
	const systemInstructions = input.systemPrompt
		? `${input.systemPrompt}\n\n---\n\n${defaultSystemInstructions}`
		: defaultSystemInstructions;

	// Build context sections
	const contextSections: string[] = [];
	if (projectId) {
		const { buildProjectContextBlock } = await import(
			"../shared/project-context-block"
		);
		const projectBlock = await buildProjectContextBlock(projectId, {
			userId,
			organizationId: organizationId ?? null,
		});
		if (projectBlock) {
			contextSections.push(projectBlock);
		}
	}
	if (ragContext && ragContext.length > 0) {
		contextSections.push(ragContext);
	}
	if (memoryContext && memoryContext.length > 0) {
		contextSections.push(`## Session Memory:\n${memoryContext}`);
	}
	if (toolSuggestionContext && toolSuggestionContext.length > 0) {
		contextSections.push(`## Suggested Tools:\n${toolSuggestionContext}`);
	}

	const skillsBlock = buildSkillsSystemBlock(availableSkills);
	if (skillsBlock) {
		contextSections.push(skillsBlock);
	}

	const baseSystemContext = [systemInstructions, ...contextSections]
		.filter(Boolean)
		.join("\n\n");

	// Apply Fabric AI prompt enhancement
	// This auto-detects appropriate patterns, contexts, and strategies based on the user's message
	let fullSystemContext = baseSystemContext;
	try {
		const fabricEnhancement = await enhancePromptWithFabric({
			userMessage: message,
			basePrompt: baseSystemContext,
		});

		if (
			fabricEnhancement.fabricUsed &&
			(fabricEnhancement.components.pattern ||
				fabricEnhancement.components.context ||
				fabricEnhancement.components.strategy)
		) {
			fullSystemContext = fabricEnhancement.systemPrompt;
			logger.info("Fabric AI prompt enhancement applied", {
				pattern: fabricEnhancement.components.pattern,
				context: fabricEnhancement.components.context,
				strategy: fabricEnhancement.components.strategy,
				cacheHits: fabricEnhancement.cacheHits,
			});
		}
	} catch (error) {
		logger.warn("Fabric AI enhancement failed, using base prompt", {
			error,
		});
	}

	// Build messages. UIMessage `parts` only carry text here; image
	// attachments are spliced into the converted CoreMessages BELOW.
	//
	// We intentionally do NOT use Vercel AI SDK 5's `FileUIPart` shape
	// (`{ type: "file", mediaType, url }`) for this — the SDK's
	// `convertToLanguageModelPrompt` calls `downloadAssets()` on every
	// FileUIPart URL, and `validateDownloadUrl()` rejects the `data:`
	// scheme with `URL scheme must be http or https, got data:`. Hosted
	// HTTPS URLs would work, but we cannot route signed S3 URLs through
	// the LLM's HTTP fetcher (private bucket, short TTL).
	//
	// Instead we follow the same pattern as the agent-executor activity:
	// build the user CoreMessage with `{ role: "user", content: [...] }`
	// where each entry is either `{ type: "text", text }` or
	// `{ type: "image", image: <data url> }`. The provider adapters
	// (OpenAI / Anthropic / Bedrock / Azure) accept the data URL inline
	// without an extra HTTP round trip, which is what we want.
	const uiMessages: Array<{
		id: string;
		role: "system" | "user" | "assistant";
		parts: Array<{ type: "text"; text: string }>;
	}> = [];

	uiMessages.push({
		id: `system_${Date.now()}`,
		role: "system",
		parts: [{ type: "text", text: fullSystemContext }],
	});

	history.forEach((h: { role: string; content: string }, i: number) => {
		uiMessages.push({
			id: `history_${i}`,
			role: h.role as "user" | "assistant",
			parts: [{ type: "text", text: h.content }],
		});
	});

	uiMessages.push({
		id: `user_${Date.now()}`,
		role: "user",
		parts: [{ type: "text", text: message }],
	});

	// Resolve image attachments for the current turn. Restricted to the
	// `attachedDocumentIds` the API explicitly forwarded for THIS message
	// — older attachments from the same chat are intentionally not
	// re-uploaded so we don't pay vision-token costs on every follow-up
	// turn. Downloads run in parallel; individual failures log a warning
	// and are dropped so a bad blob never aborts the whole response.
	//
	// Storing as raw Uint8Array (NOT a `data:` URL string): Vercel AI
	// SDK 5's `convertToLanguageModelPrompt` runs `downloadAssets` over
	// every string-typed `image` part, and `validateDownloadUrl` rejects
	// the `data:` scheme with `URL scheme must be http or https`. Passing
	// the raw bytes skips the URL fetcher entirely — the provider
	// adapters base64-encode the buffer themselves before sending to
	// OpenAI / Anthropic / Azure.
	type ImageAttachment = {
		filename: string | null;
		mediaType: string;
		bytes: Uint8Array;
	};
	const imageAttachments: ImageAttachment[] = [];
	const attachedDocumentIds = input.attachedDocumentIds ?? [];
	if (attachedDocumentIds.length > 0) {
		try {
			const { db } = await import("@repo/database");
			const docs = await db.chatDocument.findMany({
				where: {
					id: { in: attachedDocumentIds },
					userId,
					organizationId: organizationId ?? null,
					mimeType: { startsWith: "image/" },
				},
				select: {
					id: true,
					filename: true,
					mimeType: true,
					s3Path: true,
				},
			});

			if (docs.length > 0) {
				const { downloadFile } = await import("@repo/storage");
				const { config } = await import("@repo/config");
				const bucket = config.storage.bucketNames.chatDocuments;

				const settled = await Promise.all(
					docs.map(async (doc) => {
						if (!doc.s3Path || !doc.mimeType) {
							return null;
						}
						try {
							const { data } = await downloadFile(doc.s3Path, {
								bucket,
							});
							const bytes = new Uint8Array(
								data.buffer,
								data.byteOffset,
								data.byteLength,
							);
							return {
								filename: doc.filename,
								mediaType: doc.mimeType,
								bytes,
							} satisfies ImageAttachment;
						} catch (err) {
							logger.warn(
								"Failed to download image attachment for vision input — model will not see this image",
								{
									documentId: doc.id,
									filename: doc.filename,
									error:
										err instanceof Error
											? err.message
											: String(err),
								},
							);
							return null;
						}
					}),
				);

				for (const att of settled) {
					if (att) {
						imageAttachments.push(att);
					}
				}

				logger.info("Resolved image attachments for vision input", {
					requestedDocumentIds: attachedDocumentIds.length,
					imageDocumentsFound: docs.length,
					imageAttachmentsResolved: imageAttachments.length,
				});
			}
		} catch (err) {
			logger.warn(
				"Image vision lookup failed — falling back to text-only message",
				{ error: err instanceof Error ? err.message : String(err) },
			);
		}
	}

	const maxSteps =
		reasoningMode === "pro" ? 15 : reasoningMode === "balanced" ? 10 : 5;

	logger.info("System context constructed", {
		systemContextLength: fullSystemContext.length,
		hasRagContext: !!ragContext && ragContext.length > 0,
		ragContextLength: ragContext?.length ?? 0,
		messageCount: uiMessages.length,
	});

	try {
		const toolCalls: DirectChatToolCall[] = [];
		let responseText = "";
		let pendingConfirmation: DirectChatWorkflowOutput["pendingConfirmation"];

		const convertedMessages = await convertToModelMessages(
			uiMessages as any,
		);

		// Splice resolved image bytes onto the last user CoreMessage's
		// content array. The provider adapters (OpenAI / Anthropic /
		// Azure) accept Uint8Array `image` parts directly and base64-
		// encode them at the wire boundary; we cannot use `data:` URL
		// strings here because Vercel AI SDK 5's
		// `convertToLanguageModelPrompt` runs all string-typed `image`
		// parts through `downloadAssets`, which calls
		// `validateDownloadUrl` and rejects the `data:` scheme.
		if (imageAttachments.length > 0) {
			let lastUserIdx = -1;
			for (let i = convertedMessages.length - 1; i >= 0; i--) {
				if (
					(convertedMessages[i] as { role?: string })?.role === "user"
				) {
					lastUserIdx = i;
					break;
				}
			}
			if (lastUserIdx >= 0) {
				const target = convertedMessages[lastUserIdx] as {
					role: "user";
					content: unknown;
				};
				const existingText =
					typeof target.content === "string"
						? [{ type: "text" as const, text: target.content }]
						: Array.isArray(target.content)
							? (target.content as Array<{
									type: string;
									[k: string]: unknown;
								}>)
							: [];
				const imageParts = imageAttachments.map((att) => ({
					type: "image" as const,
					image: att.bytes,
					mediaType: att.mediaType,
				}));
				(
					convertedMessages[lastUserIdx] as {
						role: "user";
						content: unknown;
					}
				).content = [...existingText, ...imageParts];
				logger.info("Spliced image content parts into user message", {
					images: imageAttachments.length,
					existingTextParts: existingText.length,
				});
			} else {
				logger.warn(
					"No user message in converted prompt to attach images to",
					{ images: imageAttachments.length },
				);
			}
		}

		logger.info("Calling streamText", {
			maxSteps,
			hasTools,
			messageCount: uiMessages.length,
			convertedMessageCount: convertedMessages.length,
			imageAttachmentsAttached: imageAttachments.length,
		});

		const shouldUseTools = toolsEnabled;

		const forcedFrameToolName =
			requestedFrameOutput === "slideshow"
				? "fabric_create_slideshow"
				: requestedFrameOutput === "frame"
					? "fabric_create_frame"
					: undefined;

		// Compute providerOptions FIRST so the forcedToolChoice decision
		// below can see whether Anthropic extended thinking will be
		// enabled on this request. Order matters: see PR #1177 (excalidraw
		// chat-node fix) — Anthropic rejects `thinking: enabled` paired
		// with `tool_choice: {type:"tool"}` with HTTP 400.
		const providerOptions = buildProviderOptions(
			metadata.provider,
			metadata.modelString,
			reasoningMode as "lite" | "balanced" | "pro" | undefined,
		);
		// Paired with `providerOptions` — see `resolveOutputTokenBudget` for
		// why the thinking value has to win over the computed budget, and why
		// omitting `max_tokens` entirely silently truncated long answers.
		const maxOutputTokens = resolveOutputTokenBudget({
			providerOptions,
			metadata,
			promptChars:
				fullSystemContext.length +
				message.length +
				(history
					?.map((entry: { content: string }) => entry.content)
					.join("").length ?? 0),
		});

		// The forced tool_choice is demoted to "auto" when thinking is on,
		// even if the prompt heuristic matched. Tested by
		// `decide-forced-tool-choice.test.ts`. The demotion is logged so
		// operators can see in traces when the heuristic was suppressed.
		const thinkingEnabled = providerOptions !== undefined;
		const forcedToolChoice = decideForcedToolChoice({
			forcedToolName: shouldUseTools ? forcedFrameToolName : undefined,
			availableTools: shouldUseTools
				? (allTools as Record<string, unknown>)
				: {},
			thinkingEnabled,
		});
		if (
			forcedFrameToolName &&
			forcedFrameToolName in allTools &&
			thinkingEnabled &&
			forcedToolChoice === "auto"
		) {
			logger.info(
				"Demoted forced tool_choice to 'auto' because Anthropic thinking is enabled (incompatible per Anthropic API). Relying on prompt routing.",
				{
					forcedFrameToolName,
					provider: metadata.provider,
					model: metadata.modelString,
					reason: "anthropic-thinking-vs-tool-choice-incompat",
				},
			);
		}

		const result = streamText({
			model: model as Parameters<typeof streamText>[0]["model"],
			system: fullSystemContext,
			stopWhen: stepCountIs(maxSteps),
			messages: convertedMessages,
			...(shouldUseTools ? { tools: allTools as any } : {}),
			...(forcedToolChoice ? { toolChoice: forcedToolChoice } : {}),
			...(providerOptions ? { providerOptions } : {}),
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			// Allow multi-tool workflows - AI will chain tools as needed
			// stepCountIs(maxSteps) provides the safety limit
		});

		let partCount = 0;
		let textPartCount = 0;
		let reasoningText = "";
		let reasoningStartedAt: number | undefined;
		let reasoningCompletedAt: number | undefined;
		let reasoningDurationMs: number | undefined;
		let tokenUsage:
			| {
					inputTokens?: number;
					outputTokens?: number;
					totalTokens?: number;
					reasoningTokens?: number;
					cachedInputTokens?: number;
			  }
			| undefined;

		// Heartbeat helper - sends progress updates every 2 seconds
		let lastHeartbeatTime = Date.now();
		const HEARTBEAT_INTERVAL_MS = 350;

		const sendHeartbeat = (
			phase: string,
			message: string,
			progress: number,
		) => {
			const now = Date.now();
			if (now - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
				const details: ActivityHeartbeatDetails = {
					phase,
					message,
					progress,
					toolCalls: [...toolCalls],
					responseText,
					reasoningText,
					reasoningDurationMs,
					timestamp: now,
				};
				heartbeat(details);
				lastHeartbeatTime = now;
				logger.info("Heartbeat sent", {
					phase,
					toolCallCount: toolCalls.length,
				});
			}
		};

		// Send initial heartbeat
		sendHeartbeat("streaming", "Processing AI response...", 65);

		const partialToolInputs = new Map<string, string>();

		for await (const part of result.fullStream) {
			partCount++;

			// Cast once for the type check; part is a discriminated union in SDK 6.
			const partType =
				typeof part === "object" && part !== null
					? (part as { type?: string }).type
					: undefined;

			// Begin-of-block: explicit `reasoning-start` event from native reasoning models.
			if (
				partType === "reasoning-start" &&
				reasoningStartedAt === undefined
			) {
				reasoningStartedAt = Date.now();
				continue;
			}

			// Content chunk: `reasoning-delta` with non-empty `delta` field.
			const reasoningChunk = extractReasoningText(part);
			if (reasoningChunk !== null) {
				// Fallback: capture start on first delta when no `reasoning-start` was emitted
				// (e.g., extractReasoningMiddleware-wrapped DeepSeek R1 emits only deltas).
				if (reasoningStartedAt === undefined) {
					reasoningStartedAt = Date.now();
				}
				reasoningText += reasoningChunk;
				sendHeartbeat("streaming", "Model is thinking…", 68);
				continue;
			}

			// End-of-block: explicit `reasoning-end` event. Capture the end timestamp once.
			if (
				partType === "reasoning-end" &&
				reasoningStartedAt !== undefined &&
				reasoningCompletedAt === undefined
			) {
				reasoningCompletedAt = Date.now();
				reasoningDurationMs = reasoningCompletedAt - reasoningStartedAt;
				continue;
			}

			// Fallback: first non-reasoning part after at least one reasoning part means
			// the model switched from thinking to answering. Cover providers that omit
			// `reasoning-end`.
			if (
				reasoningStartedAt !== undefined &&
				reasoningCompletedAt === undefined
			) {
				reasoningCompletedAt = Date.now();
				reasoningDurationMs = reasoningCompletedAt - reasoningStartedAt;
			}

			if (part.type === "text-delta") {
				textPartCount++;
				responseText += part.text || "";
				// Send heartbeat periodically during text streaming
				sendHeartbeat("streaming", "Generating response...", 70);
			} else if (part.type === "tool-input-start") {
				const serverInfo = toolToServerMap[part.toolName];
				partialToolInputs.set(part.id, "");

				if (!toolCalls.find((tc) => tc.id === part.id)) {
					toolCalls.push({
						id: part.id,
						name: part.toolName,
						serverName: serverInfo?.serverName,
						args: {},
						status: "pending",
						mcpAppResourceUri: serverInfo?.resourceUri,
						mcpAppConfigId: serverInfo?.resourceUri
							? serverInfo.configId
							: undefined,
					});
				}

				lastHeartbeatTime = 0;
				sendHeartbeat(
					"tool_input",
					`Preparing tool input: ${part.toolName}`,
					72,
				);
			} else if (part.type === "tool-input-delta") {
				const nextInput =
					(partialToolInputs.get(part.id) ?? "") + part.delta;
				partialToolInputs.set(part.id, nextInput);

				const parsed = parsePartialJson(nextInput);
				if (
					parsed.value &&
					typeof parsed.value === "object" &&
					!Array.isArray(parsed.value)
				) {
					const toolCall = toolCalls.find((tc) => tc.id === part.id);
					if (toolCall) {
						toolCall.args = parsed.value as Record<string, unknown>;
					}
				}

				lastHeartbeatTime = 0;
				sendHeartbeat("tool_input", "Updating tool input...", 74);
			} else if (part.type === "tool-call") {
				logger.info("Tool call received", { toolName: part.toolName });
				const serverInfo = toolToServerMap[part.toolName];
				const existingToolCall = toolCalls.find(
					(tc) => tc.id === part.toolCallId,
				);
				if (existingToolCall) {
					existingToolCall.name = part.toolName;
					existingToolCall.serverName = serverInfo?.serverName;
					existingToolCall.args = part.input as Record<
						string,
						unknown
					>;
					existingToolCall.status = "running";
					existingToolCall.mcpAppResourceUri =
						serverInfo?.resourceUri;
					existingToolCall.mcpAppConfigId = serverInfo?.resourceUri
						? serverInfo.configId
						: undefined;
				} else {
					toolCalls.push({
						id: part.toolCallId,
						name: part.toolName,
						serverName: serverInfo?.serverName,
						args: part.input as Record<string, unknown>,
						status: "running",
						mcpAppResourceUri: serverInfo?.resourceUri,
						mcpAppConfigId: serverInfo?.resourceUri
							? serverInfo.configId
							: undefined,
					});
				}
				// Send immediate heartbeat for tool call start
				lastHeartbeatTime = 0; // Force heartbeat
				sendHeartbeat(
					"tool_calling",
					`Calling tool: ${part.toolName}`,
					75,
				);
			} else if (part.type === "tool-result") {
				const toolCall = toolCalls.find(
					(tc) => tc.id === part.toolCallId,
				);
				if (toolCall) {
					toolCall.result = part.output;
					// Tools in this file report failures as structured
					// results ({ error: string }) rather than throwing, so
					// the AI SDK never emits a tool-error part for them —
					// classify those as errors here or the client renders a
					// failed call with the success state.
					const output =
						part.output && typeof part.output === "object"
							? (part.output as {
									authorityRequired?: boolean;
									error?: unknown;
								})
							: undefined;
					const outputError =
						typeof output?.error === "string" &&
						output.error.length > 0
							? output.error
							: undefined;
					if (output?.authorityRequired || outputError) {
						toolCall.status = "error";
						if (outputError) {
							toolCall.error = outputError;
						}
					} else {
						toolCall.status = "complete";
					}
					// Attach MCP App metadata if this tool has an interactive UI resource
					const serverInfo = toolToServerMap[part.toolName];
					if (serverInfo?.resourceUri) {
						toolCall.mcpAppResourceUri = serverInfo.resourceUri;
						toolCall.mcpAppConfigId = serverInfo.configId;
						logger.info(
							`MCP App UI detected for tool ${part.toolName}`,
							{
								resourceUri: serverInfo.resourceUri,
							},
						);
					}
					// Send immediate heartbeat for tool completion
					lastHeartbeatTime = 0; // Force heartbeat
					sendHeartbeat(
						"tool_complete",
						`Tool completed: ${toolCall.name}`,
						80,
					);

					if (
						part.output &&
						typeof part.output === "object" &&
						"requiresConfirmation" in part.output &&
						(part.output as { requiresConfirmation?: boolean })
							.requiresConfirmation
					) {
						const conf = part.output as unknown as {
							workflowId: string;
							workflowName: string;
							description?: string;
							message: string;
						};
						pendingConfirmation = {
							workflowId: conf.workflowId,
							workflowName: conf.workflowName,
							description: conf.description,
							message: conf.message,
						};
					}
				}
			} else if (part.type === "error") {
				streamErrorMessage ??= extractStreamErrorMessage(part);
				logger.error("Stream error", {
					error: part,
					partCount,
					streamErrorMessage,
				});
			} else if (part.type === "finish") {
				const finishPart = part as any;
				streamFinishReason = finishPart.finishReason;
				logger.info("Stream finish event", {
					finishReason: finishPart.finishReason,
				});
			}
		}

		// Send final heartbeat
		lastHeartbeatTime = 0;
		sendHeartbeat("completing", "Finalizing response...", 95);

		// Get token usage
		const usage = await result.usage;
		if (usage?.totalTokens) {
			tokenUsage = {
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: usage.totalTokens,
				reasoningTokens: (usage as any).outputTokenDetails
					?.reasoningTokens,
				cachedInputTokens: (usage as any).inputTokenDetails
					?.cacheReadTokens,
			};
			logger.info("Token usage from model", { tokenUsage });
		} else {
			const inputText =
				fullSystemContext +
				message +
				(history
					?.map((h: { role: string; content: string }) => h.content)
					.join("") || "");
			const estimatedInputTokens = Math.ceil(inputText.length / 4);
			const estimatedOutputTokens = Math.ceil(responseText.length / 4);
			tokenUsage = {
				inputTokens: estimatedInputTokens,
				outputTokens: estimatedOutputTokens,
				totalTokens: estimatedInputTokens + estimatedOutputTokens,
			};
			logger.info("Token usage estimated", { tokenUsage });
		}

		logger.info("Stream processing complete", {
			totalParts: partCount,
			textParts: textPartCount,
			responseLength: responseText.length,
			toolCallCount: toolCalls.length,
			tokenUsage,
		});

		const durationMs = Date.now() - startTime;
		if (tokenUsage) {
			logModelUsageAsync({
				context: { userId, organizationId },
				metadata,
				taskType: taskType as any,
				usage: tokenUsage,
				latencyMs: durationMs,
				projectId,
			});
		}

		// A stream that ended without producing a turn must not report
		// success: the workflow branches on this to persist a failure
		// outcome and to fire the tools-disabled retry, and the client
		// renders an unsettled tool call as an indefinite spinner. See
		// `stream-outcome.ts` for the failure this was written against.
		const streamOutcome = resolveStreamOutcome({
			responseText,
			toolCalls,
			streamErrorMessage,
			pendingConfirmation,
			finishReason: streamFinishReason,
		});

		if (streamOutcome.error) {
			logger.error("Stream produced no answer", {
				error: streamOutcome.error,
				streamErrorMessage,
				finishReason: streamFinishReason,
				partCount,
				toolCallCount: toolCalls.length,
			});
			return {
				success: false,
				responseText: "",
				reasoningText,
				reasoningDurationMs,
				toolCalls: streamOutcome.toolCalls,
				error: streamOutcome.error,
				durationMs,
				usage: tokenUsage,
			};
		}

		// Fallback for empty response with attached documents. Deliberately
		// after the check above: when the stream actually errored, that
		// message is the truth and must not be replaced by a guess about
		// document processing.
		if (!responseText && input.attachedDocumentIds?.length) {
			logger.warn(
				"AI returned empty response despite attached documents",
				{
					documentCount: input.attachedDocumentIds.length,
					hasRagContext: !!ragContext && ragContext.length > 0,
					toolCallCount: toolCalls.length,
				},
			);

			if (
				ragContext &&
				(ragContext.includes("Document Processing Status") ||
					ragContext.includes("Document Processing Error") ||
					ragContext.includes("no relevant content"))
			) {
				responseText = ragContext.replace(/^[\n\s]*##\s*/, "").trim();
			} else if (!ragContext || ragContext.length === 0) {
				responseText =
					"I couldn't retrieve the content from the attached document(s). The document may still be processing. Please wait and try again.";
			} else {
				responseText =
					"I received the document context but wasn't able to generate a response. Please try rephrasing your question.";
			}
		}

		return {
			success: true,
			responseText,
			reasoningText,
			reasoningDurationMs,
			toolCalls: streamOutcome.toolCalls,
			pendingConfirmation,
			durationMs,
			usage: tokenUsage,
		};
	} catch (error) {
		// Rethrow AI usage-limit errors immediately so the workflow does NOT
		// fire the degraded retry and double-charge quota. @repo/payments is
		// not a direct dep of @repo/temporal, so use the error name instead.
		if (
			error instanceof Error &&
			error.name === "AiUsageLimitExceededError"
		) {
			throw error;
		}
		const rawMessage =
			error instanceof Error ? error.message : "Unknown error";
		// The AI SDK throws a generic "No output generated..." when the stream
		// errored; in that case the real provider error is in streamErrorMessage.
		// For any other thrown error, prefer the actual exception over a stale
		// stream-error captured earlier in the loop.
		const surfacedError =
			rawMessage.includes("No output generated") && streamErrorMessage
				? streamErrorMessage
				: rawMessage;
		logger.error("Failed to execute direct chat", {
			error,
			surfacedError,
			streamErrorMessage,
			mcpToolCount: Object.keys(mcpTools).length,
		});
		return {
			success: false,
			error: surfacedError,
			durationMs: Date.now() - startTime,
		};
	} finally {
		for (const client of mcpClients) {
			await closeMcpClientSafe(client);
		}
	}
}
