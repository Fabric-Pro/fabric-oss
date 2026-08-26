/**
 * MCP Tool Handler
 *
 * Handles steps that execute via MCP tools (default execution path).
 * Manages MCP client connections, tool loading, filtering, and execution.
 *
 * Real-time Progress Updates:
 * This handler sends heartbeats during tool execution to provide real-time
 * updates to the frontend. Heartbeats include tool call status and progress.
 *
 * It also publishes events to PartyKit for instant UI updates without polling.
 */

import {
	generateObject,
	generateText,
	NoSuchToolError,
	stepCountIs,
	streamText,
} from "@repo/ai";
import {
	invalidateMcpClientCache,
	OAuthAuthorizationRequiredError,
} from "@repo/mcp";
import { heartbeat } from "@temporalio/activity";
import type { z } from "zod";
import { makeInFlightToolCompactor } from "../../../agentic-loop/in-flight-tool-compaction";
import { guardToolWriteForReadOnly } from "../../../shared/read-only-gate";
import { validateToolsForDestructivePatterns } from "../../planning/operation-risk-detector";
import type {
	AgentVariable,
	ExecuteStepInput,
	ExecuteStepOutput,
	OrchestratorHeartbeatDetails,
} from "../../types";
import {
	getAiModel,
	getToolLearningContext,
	recordFailedToolCall,
	recordSuccessfulToolCall,
} from "../../utils";
import {
	publishStepProgress,
	publishToolComplete,
	publishToolInput,
	publishToolStart,
	type ToolCallEvent,
} from "../../utils/partykit-publisher";
import {
	buildExecutionContext,
	extractArtifactsFromResults,
	filterToolsByRiskLevel,
	filterToolsByStepEntity,
	formatToolResultsAsDirectResponse,
} from "../context/execution-context-builder";
import { parsePartialJson } from "../context/partial-json";
import { loadMcpTools } from "../context/tool-loader";
import {
	clearChartArtifacts,
	getChartArtifacts,
	getChartToolRecord,
} from "./chart-tool";
import type {
	HandlerContext,
	HandlerResult,
	McpToolInfo,
	StepHandler,
	ToolCallRecord,
} from "./types";

/**
 * Deduplicate tool calls by operation (name + args) to prevent showing duplicate
 * tool calls during streaming when the AI retries a tool call.
 *
 * Each retry gets a new toolCallId from the AI SDK, but represents the same operation.
 * We keep the most recent status (success > error > running) and the most recent result.
 */
function deduplicateToolCallsByOperation(
	toolCalls: ToolCallEvent[],
): ToolCallEvent[] {
	const toolCallsByKey = new Map<string, ToolCallEvent[]>();

	for (const tc of toolCalls) {
		// Create a unique key based on tool name AND essential arguments
		const argsKey = tc.args ? JSON.stringify(tc.args) : "no-args";
		const key = `${tc.name}:${argsKey}`;
		const existing = toolCallsByKey.get(key) || [];
		existing.push(tc);
		toolCallsByKey.set(key, existing);
	}

	const deduplicated: ToolCallEvent[] = [];
	for (const [_key, calls] of toolCallsByKey) {
		if (calls.length === 1) {
			deduplicated.push(calls[0]);
		} else {
			// Multiple calls with same name+args (retry scenario)
			// Prefer: complete > error > running > pending
			const statusPriority: Record<string, number> = {
				complete: 4,
				error: 3,
				running: 2,
				pending: 1,
			};
			const sorted = calls.sort(
				(a, b) =>
					(statusPriority[b.status] || 0) -
					(statusPriority[a.status] || 0),
			);
			// Take the one with highest priority status
			deduplicated.push(sorted[0]);
		}
	}

	return deduplicated;
}

/**
 * Context for tracking OAuth errors during tool execution.
 */
interface OAuthErrorContext {
	hasError: boolean;
	configId?: string;
	serverName?: string;
}

/**
 * Wrap MCP tools to send tool_start events before execution.
 *
 * This enables real-time UI updates when tools START executing, not just after they complete.
 * The AI SDK's generateText only provides onStepFinish which fires AFTER tools complete,
 * so we need to wrap each tool's execute function to intercept when execution begins.
 *
 * Also catches OAuth authorization errors during mid-session token expiry and tracks them
 * so the handler can return auth_required status.
 */
function wrapToolsWithStartNotification(
	tools: Record<string, unknown>,
	executionId: string | undefined,
	stepId: string,
	toolToConfig: Record<string, McpToolInfo>,
	partykitToolCalls: ToolCallEvent[],
	heartbeatToolCalls: OrchestratorHeartbeatDetails["toolCalls"],
	sendStepHeartbeat: (
		phase: OrchestratorHeartbeatDetails["phase"],
		partialResponse?: string,
	) => void,
	oauthErrorContext: OAuthErrorContext,
	/** Fabric project id — enables the Read-only mode write-gate. */
	projectId?: string,
): Record<string, unknown> {
	if (!executionId) {
		return tools;
	}

	const wrappedTools: Record<string, unknown> = {};

	for (const [toolName, tool] of Object.entries(tools)) {
		const toolObj = tool as {
			description?: string;
			inputSchema?: unknown;
			execute?: (args: unknown, options: unknown) => Promise<unknown>;
		};

		if (!toolObj.execute) {
			wrappedTools[toolName] = tool;
			continue;
		}

		const originalExecute = toolObj.execute;
		const configInfo = toolToConfig[toolName];

		wrappedTools[toolName] = {
			...toolObj,
			execute: async (args: unknown, options: unknown) => {
				const toolCallId =
					(options as { toolCallId?: string } | undefined)
						?.toolCallId ||
					`tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

				console.log(
					`[McpToolHandler] Tool execution starting: ${toolName}`,
				);

				// Publish tool_start to PartyKit for instant UI update
				await publishToolStart(executionId, stepId, {
					id: toolCallId,
					name: toolName,
					serverName: configInfo?.serverName,
					args,
					mcpAppResourceUri: configInfo?.resourceUri,
					mcpAppConfigId: configInfo?.resourceUri
						? configInfo.configId
						: undefined,
				}).catch(() => {}); // Non-blocking

				// Add to PartyKit tracking with "running" status
				partykitToolCalls.push({
					id: toolCallId,
					name: toolName,
					serverName: configInfo?.serverName,
					args,
					status: "running",
					mcpAppResourceUri: configInfo?.resourceUri,
					mcpAppConfigId: configInfo?.resourceUri
						? configInfo.configId
						: undefined,
				});

				// Add to heartbeat tracking
				heartbeatToolCalls.push({
					id: toolCallId,
					name: toolName,
					serverName: configInfo?.serverName,
					status: "running",
					args: args as Record<string, unknown>,
					mcpAppResourceUri: configInfo?.resourceUri,
					mcpAppConfigId: configInfo?.resourceUri
						? configInfo.configId
						: undefined,
				});

				// Send heartbeat to update UI immediately
				sendStepHeartbeat("executing");

				// Read-only mode: orchestrator tools execute
				// in-process (not via the executeMcpTool activity), so this
				// wrapper is the final Fabric-owned code before the external
				// call. Block write-classified tools for read-only projects.
				const readOnlyBlock = await guardToolWriteForReadOnly(
					projectId,
					configInfo?.originalName || toolName,
				);
				if (readOnlyBlock) {
					console.log(
						`[McpToolHandler] Blocked write tool "${toolName}" — project ${projectId} is in Read-only mode`,
					);
					return readOnlyBlock;
				}

				// Execute the original tool with OAuth error handling
				try {
					return await originalExecute.call(toolObj, args, options);
				} catch (error) {
					// Catch OAuth authorization required errors (mid-session token expiry)
					if (error instanceof OAuthAuthorizationRequiredError) {
						console.warn(
							`[McpToolHandler] OAuth authorization required during tool execution: ${toolName}`,
							error.message,
						);
						// Track the error so we can return auth_required status
						oauthErrorContext.hasError = true;
						oauthErrorContext.configId =
							error.configId || configInfo?.configId;
						oauthErrorContext.serverName =
							error.serverName || configInfo?.serverName;
					}
					throw error;
				}
			},
		};
	}

	return wrappedTools;
}

export class McpToolHandler implements StepHandler {
	readonly name = "mcp-tool";
	readonly capabilities = ["mcp_tool"];

	canHandle(_input: ExecuteStepInput): boolean {
		// MCP tool handler is the default fallback
		// It handles any step not handled by other handlers
		return true;
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		const executor = input.step.executor;

		// Track if agent delegation was attempted but failed (for error reporting)
		const agentDelegationAttempted = false;
		const agentDelegationError: string | null = null;

		try {
			const output = await this.executeMcpToolPath(
				input,
				agentDelegationAttempted,
				agentDelegationError,
				executor,
			);
			return {
				handled: true,
				output,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error("[McpToolHandler] MCP tool execution failed:", error);
			return {
				handled: false,
				error: errorMessage,
				shouldFallback: false, // MCP handler is the last resort
			};
		}
	}

	/**
	 * Execute with fallback context from a failed agent delegation.
	 */
	async executeWithFallback(
		input: ExecuteStepInput,
		agentDelegationError: string,
	): Promise<ExecuteStepOutput> {
		return this.executeMcpToolPath(
			input,
			true,
			agentDelegationError,
			input.step.executor,
		);
	}

	/**
	 * Filter tools by runtime authority.
	 * Tools from providers without active authority grants are removed.
	 * This enforces Pipes-style session-scoped authorization.
	 */
	private async filterByAuthority(
		tools: Record<string, unknown>,
		toolToConfig: Record<string, McpToolInfo>,
		userId: string,
		organizationId?: string,
		executionId?: string,
	): Promise<Record<string, unknown>> {
		try {
			const { checkMcpToolAuthority } = await import("../authority-gate");

			const authorizedTools: Record<string, unknown> = {};
			const deniedProviders = new Set<string>();

			for (const [toolName, tool] of Object.entries(tools)) {
				const configInfo = toolToConfig[toolName];
				if (!configInfo) {
					// Unknown tool — include it (fail-open for platform tools)
					authorizedTools[toolName] = tool;
					continue;
				}

				// Use server key for provider resolution
				const serverKey = configInfo.serverName || configInfo.configId;

				// Cache authority check per provider (avoid repeated DB calls)
				if (deniedProviders.has(serverKey)) {
					continue;
				}

				const result = await checkMcpToolAuthority({
					userId,
					organizationId,
					serverKey,
					toolName,
					runType: "ORCHESTRATOR",
					runId: executionId,
				});

				if (result.authorized) {
					authorizedTools[toolName] = tool;
				} else {
					deniedProviders.add(serverKey);
					console.log(
						`[McpToolHandler] Authority denied for tool "${toolName}" (provider: ${result.providerKey}): ${result.reason}`,
					);
				}
			}

			if (deniedProviders.size > 0) {
				console.log(
					`[McpToolHandler] Authority filtered out ${Object.keys(tools).length - Object.keys(authorizedTools).length} tools from ${deniedProviders.size} provider(s)`,
				);
			}

			return authorizedTools;
		} catch (error) {
			// Fail closed — authority check errors block all external tools
			console.error(
				"[McpToolHandler] Authority check error, blocking tools:",
				error,
			);
			return {};
		}
	}

	private async executeMcpToolPath(
		input: ExecuteStepInput,
		_agentDelegationAttempted: boolean,
		agentDelegationError: string | null,
		executor: string | undefined,
	): Promise<ExecuteStepOutput> {
		const toolCalls: ToolCallRecord[] = [];
		const outputVariables: Record<string, AgentVariable> = {};

		// Load MCP tools
		const {
			tools: allTools,
			toolToConfig,
			authRequiredConfigs,
		} = await loadMcpTools(input);

		// Check if any required configs need OAuth authorization
		// If the step specifically requires tools from these servers, we need to stop
		if (authRequiredConfigs && authRequiredConfigs.length > 0) {
			const stepApp = input.step.app;
			const stepToolsToUse = input.step.toolsToUse;

			// Check if the step requires a tool from an auth-required server
			let authBlocksStep = false;
			let blockingConfig = authRequiredConfigs[0];

			// If step specifies specific tools or app, check if they're from auth-required servers
			if (stepToolsToUse && stepToolsToUse.length > 0) {
				// Step requires specific tools - check if any are from auth-required servers
				// For now, if we have any auth required and no tools loaded, block
				if (Object.keys(allTools).length === 0) {
					authBlocksStep = true;
				}
			} else if (stepApp) {
				// Step requires an app - check if that app's server needs auth
				const appPrefix = stepApp.split("_")[0]?.toLowerCase();
				if (appPrefix) {
					for (const config of authRequiredConfigs) {
						const serverName = (
							config.displayName ||
							config.serverName ||
							""
						).toLowerCase();
						if (
							serverName.includes(appPrefix) ||
							appPrefix.includes(serverName.split(" ")[0])
						) {
							authBlocksStep = true;
							blockingConfig = config;
							break;
						}
					}
				}
			}

			// If auth blocks this step, return auth_required status
			if (authBlocksStep && blockingConfig) {
				console.log(
					`[McpToolHandler] Step blocked - OAuth authorization required for ${blockingConfig.displayName || blockingConfig.serverName}`,
				);
				return {
					status: "auth_required",
					outputs: {
						error: `OAuth authorization required for "${blockingConfig.displayName || blockingConfig.serverName}". Please connect this service in Settings.`,
					},
					response: `I need access to ${blockingConfig.displayName || blockingConfig.serverName} to complete this step, but it requires authorization. Please connect this service in Settings and try again.`,
					authRequired: {
						configId: blockingConfig.configId,
						serverName:
							blockingConfig.displayName ||
							blockingConfig.serverName,
					},
				};
			}
		}

		// ── Authority gate: check runtime authority for connected providers ──
		// This enforces the Pipes-style session-scoped authorization model.
		// Tools from providers without active authority grants are filtered out.
		const authorityFilteredTools = await this.filterByAuthority(
			allTools,
			toolToConfig,
			input.userId,
			input.organizationId,
			input.executionId,
		);

		// Filter tools based on step risk level
		let filteredTools = filterToolsByRiskLevel(
			authorityFilteredTools,
			input.step.riskLevel || "low",
		);

		// Apply additional filtering based on step context
		filteredTools = this.applyContextualFiltering(input, filteredTools);

		console.log(
			`[McpToolHandler] Step risk level: ${input.step.riskLevel || "low"}`,
		);
		console.log(
			`[McpToolHandler] Filtered tools: ${Object.keys(filteredTools).length} of ${Object.keys(allTools).length}`,
		);
		console.log(
			"[McpToolHandler] Tools for this step:",
			Object.keys(filteredTools),
		);

		// ==========================================================================
		// EXECUTION-TIME ENFORCEMENT: Block destructive tools if step not approved
		// This is the CRITICAL safety gate - AI should NEVER have access to destructive
		// tools unless the step has been explicitly approved for destructive operations.
		// ==========================================================================
		const toolNames = Object.keys(filteredTools);
		const destructiveValidation =
			validateToolsForDestructivePatterns(toolNames);

		if (destructiveValidation.isDestructive) {
			const stepRequiresApproval = input.step.requiresApproval;
			const stepRiskLevel = input.step.riskLevel || "low";
			const isApprovedForDestructive =
				stepRequiresApproval &&
				["critical", "high"].includes(stepRiskLevel);

			console.log(
				"[McpToolHandler] DESTRUCTIVE TOOLS DETECTED at execution time:",
				{
					tools: destructiveValidation.destructiveTools,
					patterns: destructiveValidation.patterns,
					stepRequiresApproval,
					stepRiskLevel,
					isApprovedForDestructive,
				},
			);

			// CRITICAL: If step is NOT approved for destructive operations, REMOVE all destructive tools
			// This prevents the AI from calling delete/remove tools even if they're available
			if (!isApprovedForDestructive) {
				console.warn(
					"[McpToolHandler] BLOCKING DESTRUCTIVE TOOLS - Step not approved for destructive operations",
					{
						stepDescription: input.step.description,
						blockedTools: destructiveValidation.destructiveTools,
						stepRequiresApproval,
						stepRiskLevel,
					},
				);

				// Remove destructive tools from the available tools
				for (const tool of destructiveValidation.destructiveTools) {
					delete filteredTools[tool];
				}

				console.log(
					`[McpToolHandler] After blocking: ${Object.keys(filteredTools).length} tools available (removed ${destructiveValidation.destructiveTools.length} destructive tools)`,
				);
			} else {
				console.log(
					`[McpToolHandler] Allowing destructive tools - step is approved (requiresApproval=${stepRequiresApproval}, riskLevel=${stepRiskLevel})`,
				);
			}
		}

		// Build context and prompt
		const executionContext = buildExecutionContext(input, filteredTools);
		if (Object.keys(filteredTools).length > 0) {
			return await this.executeWithTools(
				input,
				filteredTools,
				toolToConfig,
				executionContext,
				toolCalls,
				outputVariables,
				agentDelegationError,
				executor,
			);
		}

		// No tools available - generate text response
		return await this.executeWithoutTools(
			input,
			executionContext,
			agentDelegationError,
			executor,
		);
	}

	private applyContextualFiltering(
		input: ExecuteStepInput,
		initialFilteredTools: Record<string, unknown>,
	): Record<string, unknown> {
		let filteredTools = initialFilteredTools;
		const _stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;
		const stepToolsToUse = input.step.toolsToUse;
		const stepApp = input.step.app;
		const hasSpecificTools = stepToolsToUse && stepToolsToUse.length > 0;

		// Infer tools from step.app if toolsToUse not specified
		const inferredTools: string[] = [];
		if (!hasSpecificTools && stepApp && input.preloadedTools?.toolMap) {
			if (input.preloadedTools.toolMap[stepApp]) {
				inferredTools.push(stepApp);
				console.log(
					`[McpToolHandler] Using exact tool from step.app: ${stepApp}`,
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
							`[McpToolHandler] Using tools matching prefix '${appPrefix}': ${inferredTools.length} tools`,
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

		let toolFilterSource = "none";

		if (effectiveToolsToUse && effectiveToolsToUse.length > 0) {
			const toolsForStep: Record<string, unknown> = {};
			for (const toolName of effectiveToolsToUse) {
				if (filteredTools[toolName]) {
					toolsForStep[toolName] = filteredTools[toolName];
				}
			}
			if (Object.keys(toolsForStep).length > 0) {
				toolFilterSource = hasSpecificTools
					? "toolsToUse"
					: "inferred from app";
				filteredTools = toolsForStep;
			}
		} else if (input.matchedMcpTools && input.matchedMcpTools.length > 0) {
			const toolsForStep: Record<string, unknown> = {};
			const matchedToolNames = new Set(
				input.matchedMcpTools.map((t) => t.toolName),
			);

			for (const toolName of matchedToolNames) {
				if (filteredTools[toolName]) {
					toolsForStep[toolName] = filteredTools[toolName];
				}
			}

			// Add related tools from same server prefix
			const matchedPrefixes = new Set<string>();
			for (const toolName of matchedToolNames) {
				const prefix = toolName.split("_")[0];
				if (prefix && prefix.length >= 3) {
					matchedPrefixes.add(prefix);
				}
			}

			for (const toolName of Object.keys(filteredTools)) {
				const prefix = toolName.split("_")[0];
				if (matchedPrefixes.has(prefix)) {
					const isReadTool =
						toolName.includes("_get_") ||
						toolName.includes("_list_") ||
						toolName.includes("_search_") ||
						toolName.endsWith("_get") ||
						toolName.endsWith("_list");
					const isWriteTool =
						toolName.includes("_create_") ||
						toolName.includes("_update_") ||
						toolName.endsWith("_create") ||
						toolName.endsWith("_update");
					if (
						(isReadTool || isWriteTool) &&
						!toolsForStep[toolName]
					) {
						toolsForStep[toolName] = filteredTools[toolName];
					}
				}
			}

			if (Object.keys(toolsForStep).length > 0) {
				toolFilterSource = "matchedMcpTools from routing";
				filteredTools = toolsForStep;
			}
		}

		if (toolFilterSource !== "none") {
			console.log(
				`[McpToolHandler] Filtered tools by ${toolFilterSource}: ${Object.keys(filteredTools).length} tools`,
			);
		}

		// Entity-based filtering
		const entityFilteredTools = filterToolsByStepEntity(
			filteredTools,
			input.step.description,
		);
		if (
			Object.keys(entityFilteredTools).length > 0 &&
			Object.keys(entityFilteredTools).length <
				Object.keys(filteredTools).length
		) {
			console.log(
				`[McpToolHandler] Entity-filtered tools: ${Object.keys(entityFilteredTools).length} (from ${Object.keys(filteredTools).length})`,
			);
			filteredTools = entityFilteredTools;
		}

		return filteredTools;
	}

	private async executeWithTools(
		input: ExecuteStepInput,
		filteredTools: Record<string, unknown>,
		toolToConfig: Record<string, McpToolInfo>,
		executionContext: ReturnType<typeof buildExecutionContext>,
		toolCalls: ToolCallRecord[],
		outputVariables: Record<string, AgentVariable>,
		agentDelegationError: string | null,
		executor: string | undefined,
	): Promise<ExecuteStepOutput> {
		const availableToolNames = Object.keys(toolToConfig);
		const learningContext = getToolLearningContext(availableToolNames);

		// Get execution ID for PartyKit publishing (passed via ExecuteStepInput)
		const executionId = input.executionId;

		console.log(
			`[McpToolHandler] Using AI SDK native tool execution with maxSteps=${executionContext.maxSteps}`,
		);

		// Heartbeat tracking for real-time progress
		const heartbeatToolCalls: OrchestratorHeartbeatDetails["toolCalls"] =
			[];

		// PartyKit tool call tracking for real-time UI updates
		const partykitToolCalls: ToolCallEvent[] = [];

		const sendStepHeartbeat = (
			phase: OrchestratorHeartbeatDetails["phase"],
			partialResponse?: string,
		) => {
			const details: OrchestratorHeartbeatDetails = {
				stepId: input.step.id,
				stepDescription: input.step.description,
				phase,
				toolCalls: [...heartbeatToolCalls],
				partialResponse,
				timestamp: Date.now(),
			};
			heartbeat(details);
			console.log(
				`[McpToolHandler] Heartbeat: phase=${phase}, toolCalls=${heartbeatToolCalls.length}`,
			);

			// Also publish to PartyKit for instant UI updates
			if (executionId) {
				// Deduplicate tool calls by name+args before publishing to prevent
				// duplicates from appearing in the UI during streaming (e.g., when AI retries
				// a tool call, each retry has a different ID but same operation)
				const deduplicatedPartykitToolCalls =
					deduplicateToolCallsByOperation(partykitToolCalls);

				publishStepProgress(executionId, {
					stepId: input.step.id,
					stepDescription: input.step.description,
					phase: phase as
						| "loading_tools"
						| "executing"
						| "processing_results",
					toolCalls: deduplicatedPartykitToolCalls,
					partialResponse,
				}).catch(() => {}); // Non-blocking
				console.log(
					`[McpToolHandler] Published to PartyKit: phase=${phase}, tools=${deduplicatedPartykitToolCalls.length}`,
				);
			}
		};

		const modelStartTime = Date.now();
		const model = await getAiModel(
			input.userId,
			input.organizationId,
			true,
		);
		console.log(
			`[McpToolHandler] Model selection took ${Date.now() - modelStartTime}ms`,
		);

		// Send heartbeat for tool loading phase
		sendStepHeartbeat("loading_tools");

		// Add built-in chart tool for data visualization
		// This is always available alongside MCP tools
		const chartTool = getChartToolRecord();
		const toolsWithChart = { ...filteredTools, ...chartTool };
		clearChartArtifacts(); // Clear any previous artifacts

		const llmStartTime = Date.now();
		console.log(
			`[McpToolHandler] Starting LLM call with ${Object.keys(toolsWithChart).length} tools (including create_chart)...`,
		);
		console.log(
			`[McpToolHandler] Tool names: ${Object.keys(toolsWithChart).join(", ")}`,
		);
		let stepNumber = 0;

		// Track OAuth errors that occur during tool execution (mid-session token expiry)
		const oauthErrorContext: OAuthErrorContext = { hasError: false };

		// Wrap tools to send tool_start notifications when they begin executing
		// This enables real-time UI updates showing tools as they start, not just after they complete
		const wrappedTools = wrapToolsWithStartNotification(
			toolsWithChart,
			executionId,
			input.step.id,
			toolToConfig,
			partykitToolCalls,
			heartbeatToolCalls,
			sendStepHeartbeat,
			oauthErrorContext,
			input.projectId,
		);

		// Send heartbeat for execution start
		sendStepHeartbeat("executing");

		const result = streamText({
			model,
			stopWhen: stepCountIs(executionContext.maxSteps),
			system: `${executionContext.systemPrompt}${learningContext}`,
			prompt: executionContext.stepPrompt,
			tools: wrappedTools as any,
			prepareStep: makeInFlightToolCompactor(),
			// Repair malformed tool calls (e.g., invalid JSON) using the model
			experimental_repairToolCall: async ({
				toolCall,
				tools,
				inputSchema,
				error,
			}) => {
				// Don't attempt to fix invalid tool names
				if (NoSuchToolError.isInstance(error)) {
					console.warn(
						`[McpToolHandler] Unknown tool "${toolCall.toolName}", cannot repair`,
					);
					return null;
				}

				console.log(
					`[McpToolHandler] Attempting to repair tool call "${toolCall.toolName}":`,
					{
						error:
							error instanceof Error
								? error.message
								: String(error),
						originalInput:
							typeof toolCall.input === "string"
								? toolCall.input.substring(0, 200)
								: JSON.stringify(toolCall.input).substring(
										0,
										200,
									),
					},
				);

				try {
					const tool = tools[toolCall.toolName as keyof typeof tools];
					if (!tool || !tool.inputSchema) {
						console.warn(
							`[McpToolHandler] No schema for tool "${toolCall.toolName}", cannot repair`,
						);
						return null;
					}

					// Use generateObject with the tool's schema to repair the input
					const { object: repairedArgs } = await generateObject({
						model,
						schema: tool.inputSchema as z.ZodType,
						prompt: [
							`The model tried to call the tool "${toolCall.toolName}" with the following inputs:`,
							typeof toolCall.input === "string"
								? toolCall.input
								: JSON.stringify(toolCall.input),
							`But the input was malformed. Error: ${error instanceof Error ? error.message : String(error)}`,
							"The tool accepts the following schema:",
							JSON.stringify(inputSchema(toolCall)),
							"Please fix the inputs to match the schema exactly.",
						].join("\n"),
					});

					console.log(
						`[McpToolHandler] Successfully repaired tool call "${toolCall.toolName}"`,
					);
					return { ...toolCall, input: JSON.stringify(repairedArgs) };
				} catch (repairError) {
					console.error(
						`[McpToolHandler] Failed to repair tool call "${toolCall.toolName}":`,
						repairError,
					);
					return null; // Let the original error propagate
				}
			},
			onStepFinish: (stepResult: unknown) => {
				stepNumber++;
				const elapsed = Date.now() - llmStartTime;
				const step = stepResult as {
					toolCalls?: Array<{
						toolName: string;
						toolCallId: string;
						args?: unknown;
					}>;
					toolResults?: Array<{
						toolCallId: string;
						output?: unknown; // AI SDK v5 uses 'output', not 'result'
					}>;
					text?: string;
				};

				if (step.toolCalls && step.toolCalls.length > 0) {
					const toolNames = step.toolCalls
						.map((tc) => tc.toolName)
						.join(", ");
					console.log(
						`[McpToolHandler] LLM step ${stepNumber}: executed tools [${toolNames}] (${elapsed}ms elapsed)`,
					);

					// Debug: Log mismatch between toolCalls and toolResults
					const callCount = step.toolCalls.length;
					const resultCount = step.toolResults?.length ?? 0;
					if (callCount !== resultCount) {
						console.warn(
							`[McpToolHandler] MISMATCH in step ${stepNumber}: ${callCount} tool calls but ${resultCount} results`,
							{
								toolCalls: step.toolCalls.map((tc) => ({
									name: tc.toolName,
									id: tc.toolCallId,
								})),
								toolResults:
									step.toolResults?.map((r) => ({
										id: r.toolCallId,
									})) ?? [],
							},
						);
					}

					// Add tool calls to heartbeat data and PartyKit
					for (const tc of step.toolCalls) {
						const matchingResult = step.toolResults?.find(
							(r) => r.toolCallId === tc.toolCallId,
						);
						const configInfo = toolToConfig[tc.toolName];
						const toolStatus = matchingResult
							? "complete"
							: "running";

						heartbeatToolCalls.push({
							id: tc.toolCallId,
							name: tc.toolName,
							serverName: configInfo?.serverName,
							status: toolStatus,
							args: tc.args as Record<string, unknown>,
							result: matchingResult?.output, // AI SDK v5 uses 'output' not 'result'
							mcpAppResourceUri: configInfo?.resourceUri,
							mcpAppConfigId: configInfo?.resourceUri
								? configInfo.configId
								: undefined,
						});

						// Track for PartyKit
						const partykitStatus = matchingResult
							? ("complete" as const)
							: ("running" as const);
						partykitToolCalls.push({
							id: tc.toolCallId,
							name: tc.toolName,
							serverName: configInfo?.serverName,
							args: tc.args,
							result: matchingResult?.output, // AI SDK v5 uses 'output' not 'result'
							status: partykitStatus,
							durationMs: elapsed,
							mcpAppResourceUri: configInfo?.resourceUri,
							mcpAppConfigId: configInfo?.resourceUri
								? configInfo.configId
								: undefined,
						});

						// Publish individual tool completion to PartyKit for instant updates
						if (executionId && matchingResult) {
							publishToolComplete(executionId, input.step.id, {
								id: tc.toolCallId,
								name: tc.toolName,
								serverName: configInfo?.serverName,
								result: matchingResult?.output, // AI SDK v5 uses 'output' not 'result'
								status: "complete",
								durationMs: elapsed,
								mcpAppResourceUri: configInfo?.resourceUri,
								mcpAppConfigId: configInfo?.resourceUri
									? configInfo.configId
									: undefined,
							}).catch(() => {}); // Non-blocking
						}
					}

					// Send heartbeat with updated tool calls
					sendStepHeartbeat("executing");
				} else if (step.text) {
					console.log(
						`[McpToolHandler] LLM step ${stepNumber}: text response (${elapsed}ms elapsed)`,
					);
				} else {
					console.log(
						`[McpToolHandler] LLM step ${stepNumber}: completed (${elapsed}ms elapsed)`,
					);
				}
			},
		});

		const partialToolInputs = new Map<string, string>();
		for await (const part of result.fullStream) {
			if (part.type === "tool-input-start") {
				const configInfo = toolToConfig[part.toolName];
				partialToolInputs.set(part.id, "");

				const heartbeatTool = heartbeatToolCalls.find(
					(tc) => tc.id === part.id,
				);
				if (!heartbeatTool) {
					heartbeatToolCalls.push({
						id: part.id,
						name: part.toolName,
						serverName: configInfo?.serverName,
						status: "pending",
						args: {},
						mcpAppResourceUri: configInfo?.resourceUri,
						mcpAppConfigId: configInfo?.resourceUri
							? configInfo.configId
							: undefined,
					});
				}

				const partykitTool = partykitToolCalls.find(
					(tc) => tc.id === part.id,
				);
				if (!partykitTool) {
					partykitToolCalls.push({
						id: part.id,
						name: part.toolName,
						serverName: configInfo?.serverName,
						args: {},
						status: "pending",
						mcpAppResourceUri: configInfo?.resourceUri,
						mcpAppConfigId: configInfo?.resourceUri
							? configInfo.configId
							: undefined,
					});
				}

				if (executionId) {
					publishToolInput(executionId, input.step.id, {
						id: part.id,
						name: part.toolName,
						serverName: configInfo?.serverName,
						args: {},
						mcpAppResourceUri: configInfo?.resourceUri,
						mcpAppConfigId: configInfo?.resourceUri
							? configInfo.configId
							: undefined,
					}).catch(() => {});
				}
				continue;
			}

			if (part.type === "tool-input-delta") {
				const nextInput =
					(partialToolInputs.get(part.id) ?? "") + part.delta;
				partialToolInputs.set(part.id, nextInput);
				const parsed = parsePartialJson(nextInput);
				if (
					parsed.value &&
					typeof parsed.value === "object" &&
					!Array.isArray(parsed.value)
				) {
					const heartbeatTool = heartbeatToolCalls.find(
						(tc) => tc.id === part.id,
					);
					if (heartbeatTool) {
						heartbeatTool.args = parsed.value as Record<
							string,
							unknown
						>;
					}

					const partykitTool = partykitToolCalls.find(
						(tc) => tc.id === part.id,
					);
					if (partykitTool) {
						partykitTool.args = parsed.value;
						if (executionId) {
							publishToolInput(executionId, input.step.id, {
								id: partykitTool.id,
								name: partykitTool.name,
								serverName: partykitTool.serverName,
								args: parsed.value,
								mcpAppResourceUri:
									partykitTool.mcpAppResourceUri,
								mcpAppConfigId: partykitTool.mcpAppConfigId,
							}).catch(() => {});
						}
					}
				}
				continue;
			}

			if (part.type === "tool-call") {
				const heartbeatTool = heartbeatToolCalls.find(
					(tc) => tc.id === part.toolCallId,
				);
				if (heartbeatTool) {
					heartbeatTool.args = part.input as Record<string, unknown>;
				}
				const partykitTool = partykitToolCalls.find(
					(tc) => tc.id === part.toolCallId,
				);
				if (partykitTool) {
					partykitTool.args = part.input;
					if (executionId) {
						publishToolInput(executionId, input.step.id, {
							id: partykitTool.id,
							name: partykitTool.name,
							serverName: partykitTool.serverName,
							args: part.input,
							mcpAppResourceUri: partykitTool.mcpAppResourceUri,
							mcpAppConfigId: partykitTool.mcpAppConfigId,
						}).catch(() => {});
					}
				}
			}
		}

		const finalText = await result.text;

		// Send heartbeat for processing results phase
		sendStepHeartbeat("processing_results", finalText);

		console.log(
			`[McpToolHandler] LLM call completed in ${Date.now() - llmStartTime}ms (${stepNumber} steps)`,
		);

		// Check if OAuth error occurred during tool execution (mid-session token expiry)
		// If so, return auth_required status so UI can prompt user to reconnect
		if (oauthErrorContext.hasError) {
			console.log(
				`[McpToolHandler] OAuth authorization required mid-session for ${oauthErrorContext.serverName}`,
			);
			return {
				status: "auth_required",
				outputs: {
					error: `OAuth authorization required for "${oauthErrorContext.serverName}". Your session may have expired. Please reconnect this service in Settings.`,
					partialResponse: finalText,
				},
				response: `I was unable to complete this step because access to ${oauthErrorContext.serverName} has expired. Please reconnect this service in Settings and try again.`,
				toolCalls: [],
				authRequired: {
					configId: oauthErrorContext.configId || "",
					serverName: oauthErrorContext.serverName || "Unknown",
				},
			};
		}

		// Process tool calls from result
		// Track servers with missing results to invalidate their cache
		const serversWithMissingResults = new Set<string>();

		const completedSteps = await result.steps;
		if (completedSteps) {
			for (let stepIdx = 0; stepIdx < completedSteps.length; stepIdx++) {
				const step = completedSteps[stepIdx];
				if (step.toolCalls && step.toolCalls.length > 0) {
					// Debug: Log toolCallIds for this step
					console.log(
						`[McpToolHandler] Processing step ${stepIdx + 1} tool results:`,
						{
							toolCallIds: step.toolCalls.map((c) => ({
								name: c.toolName,
								id: c.toolCallId,
							})),
							toolResultIds:
								step.toolResults?.map((r) => ({
									id: r.toolCallId,
									hasResult:
										!!(r as any).result ||
										!!(r as any).output,
								})) ?? [],
						},
					);

					for (const call of step.toolCalls) {
						const matchingResult = step.toolResults?.find(
							(r) => r.toolCallId === call.toolCallId,
						);
						// IMPORTANT: Preserve the original toolCallId to maintain consistency
						// with PartyKit tracking. Only generate a new ID as fallback.
						const toolCallId =
							call.toolCallId ||
							`tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
						const callArgs = (call as any).args ?? {};
						const resultValue =
							(matchingResult as any)?.result ??
							(matchingResult as any)?.output;

						// Detect missing result (tool was called but result not captured)
						const isMissingResult = !matchingResult;

						const isError =
							isMissingResult ||
							(typeof resultValue === "string" &&
								(resultValue.toLowerCase().includes("error") ||
									resultValue
										.toLowerCase()
										.includes("required") ||
									resultValue
										.toLowerCase()
										.includes("failed")));

						// If result is missing, track the server for cache invalidation
						if (isMissingResult) {
							const configInfo = toolToConfig[call.toolName];
							if (configInfo?.configId) {
								serversWithMissingResults.add(
									configInfo.configId,
								);
								console.warn(
									`[McpToolHandler] Tool call "${call.toolName}" has missing result (server: ${configInfo.serverName}, configId: ${configInfo.configId}). ` +
										"This may indicate a stale MCP connection. The AI model will likely retry the call.",
								);
							}
						}

						toolCalls.push({
							id: toolCallId,
							name: call.toolName,
							args: callArgs,
							result: isMissingResult
								? {
										error: "Tool execution failed - result not captured. Connection may have dropped.",
									}
								: resultValue,
							status: isError ? "error" : "success",
							durationMs: 0,
							mcpAppResourceUri:
								toolToConfig[call.toolName]?.resourceUri,
							mcpAppConfigId: toolToConfig[call.toolName]
								?.resourceUri
								? toolToConfig[call.toolName]?.configId
								: undefined,
						});

						if (!isError) {
							recordSuccessfulToolCall(call.toolName, callArgs);
							outputVariables[`tool.${call.toolName}`] = {
								name: `tool.${call.toolName}`,
								value: resultValue,
								setBy: input.step.id,
								setAt: new Date().toISOString(),
								scope: "workflow",
							};
						} else if (typeof resultValue === "string") {
							recordFailedToolCall(
								call.toolName,
								callArgs,
								resultValue,
							);
						} else if (isMissingResult) {
							recordFailedToolCall(
								call.toolName,
								callArgs,
								"Tool execution failed - result not captured",
							);
						}

						console.log(
							`[McpToolHandler] Step tool call: ${call.toolName}`,
							isMissingResult ? "(MISSING RESULT)" : resultValue,
						);
					}
				}
			}
		}

		// Invalidate MCP client cache for servers with missing results
		// This forces a fresh connection on the next tool call (e.g., if AI model retries)
		if (serversWithMissingResults.size > 0) {
			console.log(
				`[McpToolHandler] Invalidating MCP cache for ${serversWithMissingResults.size} server(s) with missing results`,
			);
			for (const configId of serversWithMissingResults) {
				await invalidateMcpClientCache(
					configId,
					input.userId,
					input.organizationId,
				);
			}
		}

		// Deduplicate tool calls - only deduplicate if the SAME tool was called with the SAME arguments
		// (e.g., AI retry of a failed call). Different arguments mean different operations.
		// IMPORTANT: Do NOT deduplicate by tool name alone - that would hide legitimate multiple calls
		// (e.g., deleting 3 different boards with 3 delete_board calls).
		const deduplicatedToolCalls: ToolCallRecord[] = [];
		const toolCallsByKey = new Map<string, ToolCallRecord[]>();

		for (const tc of toolCalls) {
			// Create a unique key based on tool name AND essential arguments
			// This ensures we only deduplicate true retries, not different operations
			const argsKey = tc.args ? JSON.stringify(tc.args) : "no-args";
			const key = `${tc.name}:${argsKey}`;
			const existing = toolCallsByKey.get(key) || [];
			existing.push(tc);
			toolCallsByKey.set(key, existing);
		}

		for (const [_key, calls] of toolCallsByKey) {
			// If same tool was called with same args multiple times (retry scenario),
			// keep only the successful one, or the last one if none succeeded
			if (calls.length > 1) {
				const successfulCall = calls.find(
					(c) => c.status === "success",
				);
				if (successfulCall) {
					deduplicatedToolCalls.push(successfulCall);
				} else {
					// All failed - show the last one
					deduplicatedToolCalls.push(calls[calls.length - 1]);
				}
			} else {
				// Single call - keep it
				deduplicatedToolCalls.push(calls[0]);
			}
		}

		console.log(
			`[McpToolHandler] Tool calls: ${toolCalls.length} total, ${deduplicatedToolCalls.length} after deduplication (unique operations)`,
		);

		// Publish FINAL tool statuses to PartyKit after post-processing
		// This ensures UI reflects actual success/error status, not intermediate states
		if (executionId && deduplicatedToolCalls.length > 0) {
			// Update partykitToolCalls with final statuses from post-processing
			const finalToolCalls: ToolCallEvent[] = deduplicatedToolCalls.map(
				(tc) => ({
					id: tc.id,
					name: tc.name,
					serverName: toolToConfig[tc.name]?.serverName,
					args: tc.args,
					result: tc.result,
					status: tc.status === "error" ? "error" : "complete",
					durationMs: tc.durationMs,
					error:
						tc.status === "error"
							? typeof tc.result === "object" &&
								tc.result &&
								"error" in tc.result
								? String((tc.result as any).error)
								: "Tool execution failed"
							: undefined,
				}),
			);

			// Publish final step progress with accurate statuses
			publishStepProgress(executionId, {
				stepId: input.step.id,
				stepDescription: input.step.description,
				phase: "processing_results",
				toolCalls: finalToolCalls,
				partialResponse: finalText,
			}).catch(() => {}); // Non-blocking

			// Also publish individual tool completions for any that are still errors after deduplication
			for (const tc of deduplicatedToolCalls) {
				if (tc.status === "error") {
					publishToolComplete(executionId, input.step.id, {
						id: tc.id,
						name: tc.name,
						serverName: toolToConfig[tc.name]?.serverName,
						result: tc.result,
						status: "error",
						durationMs: tc.durationMs,
						error:
							typeof tc.result === "object" &&
							tc.result &&
							"error" in tc.result
								? String((tc.result as any).error)
								: "Tool execution failed",
						mcpAppResourceUri: toolToConfig[tc.name]?.resourceUri,
						mcpAppConfigId: toolToConfig[tc.name]?.resourceUri
							? toolToConfig[tc.name]?.configId
							: undefined,
					}).catch(() => {}); // Non-blocking
				}
			}

			console.log(
				`[McpToolHandler] Published final tool statuses to PartyKit: ${deduplicatedToolCalls.filter((tc) => tc.status === "success").length} success, ${deduplicatedToolCalls.filter((tc) => tc.status === "error").length} error`,
			);
		}

		// Check if tool results contain list data that should be presented directly
		// Use deduplicated calls to avoid including failed retry attempts
		let responseText = finalText || "Task completed.";
		const directListResponse = formatToolResultsAsDirectResponse(
			deduplicatedToolCalls,
			input.step.description,
		);
		if (directListResponse) {
			responseText = directListResponse;
		}

		// VERIFICATION: Check actual tool call results vs. AI claims for destructive operations
		// This prevents the AI from hallucinating success counts
		const destructiveOperations = [
			"delete",
			"remove",
			"create",
			"add",
			"update",
			"modify",
		];
		const isDestructiveStep = destructiveOperations.some((op) =>
			input.step.description.toLowerCase().includes(op),
		);

		if (isDestructiveStep && deduplicatedToolCalls.length > 0) {
			const successfulCalls = deduplicatedToolCalls.filter(
				(tc) => tc.status === "success",
			);
			const failedCalls = deduplicatedToolCalls.filter(
				(tc) => tc.status === "error",
			);
			const totalCalls = deduplicatedToolCalls.length;

			// Extract numbers from AI response that might be claims about actions taken
			const numberPattern =
				/(\d+)\s*(boards?|items?|records?|entities?|tasks?|projects?|documents?|files?|cards?)/gi;
			const matches = [...responseText.matchAll(numberPattern)];

			if (matches.length > 0) {
				// Check if AI claims a different number than actual tool calls
				for (const match of matches) {
					const claimedCount = Number.parseInt(match[1], 10);
					const entity = match[2].toLowerCase();

					// Only flag if claimed count significantly differs from actual
					if (
						claimedCount > successfulCalls.length &&
						claimedCount !== totalCalls
					) {
						console.warn(
							`[McpToolHandler] AI claimed ${claimedCount} ${entity} but only ${successfulCalls.length} tool calls succeeded (${failedCalls.length} failed)`,
						);

						// Append verification note to response
						const verificationNote = `\n\n**Verification:** ${successfulCalls.length} of ${totalCalls} operations completed successfully.${failedCalls.length > 0 ? ` ${failedCalls.length} failed.` : ""}`;
						responseText = responseText + verificationNote;
						break; // Only add one verification note
					}
				}
			}

			// Always log actual counts for debugging
			console.log(
				`[McpToolHandler] Destructive operation verification: ${successfulCalls.length}/${totalCalls} successful, ${failedCalls.length} failed`,
			);
		}

		if (agentDelegationError) {
			const errorNote = `\n\n[Note: Agent delegation to "${executor}" failed: ${agentDelegationError}. Used LLM fallback.]`;
			responseText = responseText + errorNote;
			toolCalls.unshift({
				id: `agent_error_${Date.now()}`,
				name: `delegate:${executor}`,
				args: { task: input.step.description },
				result: { error: agentDelegationError, fallback: "LLM" },
				status: "error" as const,
				durationMs: 0,
			});
		}

		// Extract artifacts from tool results and response (use deduplicated calls)
		const extractedArtifacts = extractArtifactsFromResults(
			input.step.id,
			responseText,
			deduplicatedToolCalls,
		);

		// Get chart artifacts generated by create_chart tool
		const chartArtifacts = getChartArtifacts();

		// Convert chart artifacts to ExtractedArtifact format and add to artifacts list
		const chartExtractedArtifacts = chartArtifacts.map((chart) => ({
			id: chart.id,
			type: "chart" as const,
			name: chart.config.title || "Chart",
			content: JSON.stringify(chart),
			metadata: {
				chartType: chart.chartType,
				dataPointCount: chart.data.length,
				sourceDescription: chart.metadata?.sourceDescription,
			},
		}));

		return {
			outputs: {
				response: responseText,
				toolResults: deduplicatedToolCalls.map((tc) => tc.result),
				...(executor ? { intendedExecutor: executor } : {}),
				...(agentDelegationError
					? { delegationError: agentDelegationError }
					: {}),
			},
			variables: outputVariables,
			toolCalls: deduplicatedToolCalls, // Return deduplicated list to avoid showing retry failures
			response: responseText,
			artifacts: [...extractedArtifacts, ...chartExtractedArtifacts],
		};
	}

	private async executeWithoutTools(
		input: ExecuteStepInput,
		executionContext: ReturnType<typeof buildExecutionContext>,
		agentDelegationError: string | null,
		executor: string | undefined,
	): Promise<ExecuteStepOutput> {
		console.log(
			"[McpToolHandler] No MCP tools available, generating text response",
		);

		const fallbackNote = agentDelegationError
			? `\n\n[Agent "${executor}" was unavailable: ${agentDelegationError}. Please complete this task directly.]`
			: "";

		const model = await getAiModel(
			input.userId,
			input.organizationId,
			false,
		);

		const response = await generateText({
			model,
			system: executionContext.systemPrompt,
			prompt: `${input.step.description}${fallbackNote}\n\nProvide a detailed response.`,
		});

		let responseText =
			response.text || `Completed: ${input.step.description}`;

		const fallbackToolCalls: ToolCallRecord[] = [];
		if (agentDelegationError) {
			const errorNote = `\n\n[Note: Agent delegation to "${executor}" failed: ${agentDelegationError}. Generated response using LLM fallback.]`;
			responseText = responseText + errorNote;
			fallbackToolCalls.push({
				id: `agent_error_${Date.now()}`,
				name: `delegate:${executor}`,
				args: { task: input.step.description },
				result: { error: agentDelegationError, fallback: "LLM" },
				status: "error" as const,
				durationMs: 0,
			});
		}

		return {
			outputs: {
				response: responseText,
				toolResults: [],
				...(executor ? { intendedExecutor: executor } : {}),
				...(agentDelegationError
					? { delegationError: agentDelegationError }
					: {}),
			},
			variables: {},
			toolCalls: fallbackToolCalls,
			response: responseText,
		};
	}
}
