/**
 * Agent Executor
 *
 * Executes AI agent turns with tool calling support.
 * Reuses infrastructure from orchestrator for MCP tool loading and execution.
 */

import { resolveOpenAiApiKey, stepCountIs, streamText, tool } from "@repo/ai";
import {
	db,
	ensureSensitiveOperationAuthority,
	loadProjectDatabricksKnowledgeBinding,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	getCachedMcpClientForConfig,
	OAuthAuthorizationRequiredError,
} from "@repo/mcp";
import type { AccountDefinition } from "@repo/mcp-registry";
import { getBaseUrl } from "@repo/utils";
import { Context, heartbeat } from "@temporalio/activity";
import { publishExecutionEvent } from "../../lib/redis-publisher";
import { getAgentMemoryTools } from "../agent-memory";
import { createRunAgentTool } from "../agentic-loop";
import {
	classifyIntegrationAccessLevel,
	classifyToolAccessLevel,
	resolveIntegrationProviderKey,
	resolveProviderKey,
} from "../orchestrator/execution/authority-gate";
import { getAllFabricAiTools } from "../orchestrator/tools/fabric-ai-tools";
import { jsonSchemaToZod } from "../orchestrator/utils";
import { getAiModel } from "../orchestrator/utils/model-selector";
// Deliberately from the dependency-free utils module, NOT
// `../shared/databricks-knowledge` — that module statically imports the
// Databricks integration client, which this file keeps out of its static
// import graph (the client is dynamic-imported inside tool `execute`).
import {
	type AgentDatabricksBinding,
	databricksKnowledgeToolName,
	executeDatabricksBindingSearch,
	mergeDatabricksBindings,
} from "../shared/databricks-binding-utils";
import { getFabricToolDefinitionMap } from "../shared/fabric-content-tools";
import {
	createFirstClassFrame,
	getFirstClassFrame,
	listFirstClassFrames,
	shareFirstClassFrame,
	updateFirstClassFrame,
} from "../shared/frame-service";
import { executeMicrosoftTeamsTool } from "../shared/oauth-tool-executors";
import { guardToolWriteForReadOnly } from "../shared/read-only-gate";
import type {
	ExecuteAgentTurnInput,
	ExecuteAgentTurnResult,
	ToolCallRecord,
} from "./types";

/**
 * Depth-decaying step limits — mirrors Dust's [8,8,4,2] pattern.
 * Deeper sub-agent calls get fewer steps to prevent runaway token usage.
 */
const DEPTH_MAX_STEPS = [10, 8, 4, 2] as const;

function maxStepsForDepth(depth: number): number {
	return DEPTH_MAX_STEPS[Math.min(depth, DEPTH_MAX_STEPS.length - 1)] ?? 2;
}

/**
 * MCP tool info for tracking
 */
interface McpToolInfo {
	configId: string;
	serverName: string;
	originalName: string;
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
	displayName?: string;
	action?: "request_authority" | "approve_pending" | "upgrade_access_level";
	pendingSessionId?: string;
	reason?: string;
}) {
	const {
		providerKey,
		accessLevel,
		displayName,
		action,
		pendingSessionId,
		reason,
	} = params;

	return {
		error:
			`Runtime authority required for ${displayName || providerKey}. ` +
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

/**
 * Execute a single agent turn with optional tool calling
 *
 * This activity:
 * 1. Loads MCP tools from configured servers
 * 2. Builds conversation context
 * 3. Calls the AI model with tools
 * 4. Returns the response and any tool calls made
 */
export async function executeAgentTurn(
	input: ExecuteAgentTurnInput,
): Promise<ExecuteAgentTurnResult> {
	const {
		systemPrompt,
		userMessage,
		knowledgeContext,
		mcpConfigIds,
		integrationConfigurations,
		model,
		userId,
		organizationId,
		projectId,
		maxIterations = maxStepsForDepth(input.currentDepth ?? 0),
		conversationHistory = [],
		executionId,
		imageRefs,
		builtInToolNames,
		agentInstanceId,
		callingAgentId,
		currentDepth,
	} = input;

	logger.info("[AgentExecutor] Starting agent turn", {
		hasKnowledgeContext: !!knowledgeContext,
		mcpConfigCount: mcpConfigIds?.length ?? 0,
		integrationConfigCount: integrationConfigurations?.length ?? 0,
		builtInToolCount: builtInToolNames?.length ?? 0,
		historyLength: conversationHistory.length,
		maxIterations,
	});

	const startTime = Date.now();
	const toolCalls: ToolCallRecord[] = [];

	try {
		// Load MCP tools if configured
		const { tools, toolToConfig } = await loadMcpToolsForAgent(
			mcpConfigIds || [],
			userId,
			organizationId,
		);
		for (const [toolName, toolDef] of Object.entries(tools)) {
			const configInfo = toolToConfig[toolName];
			if (!configInfo || !isExecutableToolDefinition(toolDef)) {
				continue;
			}

			const providerKey = resolveProviderKey(
				configInfo.serverName || configInfo.configId,
			);
			const accessLevel = classifyToolAccessLevel(
				configInfo.originalName || toolName,
			);

			tools[toolName] = tool({
				description: toolDef.description || toolName,
				inputSchema: toolDef.inputSchema,
				execute: async (args: Record<string, unknown>) => {
					// Read-only mode: block external write tools
					// before the authority flow; the agent relays the error.
					const readOnlyBlock = await guardToolWriteForReadOnly(
						projectId,
						configInfo.originalName || toolName,
					);
					if (readOnlyBlock) {
						return readOnlyBlock;
					}
					const authority = await ensureSensitiveOperationAuthority({
						userId,
						organizationId,
						providerKey,
						accessLevel,
						providerType: "MCP",
						providerRefId: configInfo.configId,
						providerDisplayName: configInfo.serverName,
						runType: "AGENT_INSTANCE",
						runId: executionId,
						toolName: configInfo.originalName || toolName,
					});

					if (!authority.authorized) {
						return buildAuthorityRequiredResult({
							providerKey,
							accessLevel,
							displayName: configInfo.serverName,
							action: authority.action,
							pendingSessionId: authority.pendingSessionId,
							reason: authority.reason,
						});
					}

					return toolDef.execute(args);
				},
			} as unknown as Parameters<typeof tool>[0]);
		}

		// Load OAuth integration tools (Teams, GitHub) if configured, plus the
		// project-level Databricks knowledge binding (independent of any
		// agent-level integration configuration).
		if (
			(integrationConfigurations &&
				integrationConfigurations.length > 0) ||
			projectId
		) {
			const oauthTools = await loadOAuthIntegrationToolsForAgent(
				integrationConfigurations ?? [],
				userId,
				organizationId,
				projectId,
			);
			for (const oauthTool of oauthTools) {
				const zodSchema = jsonSchemaToZod(oauthTool.inputSchema);
				const providerKey = resolveIntegrationProviderKey(
					oauthTool.serverName,
				);
				const accessLevel = classifyIntegrationAccessLevel(
					oauthTool.originalName,
					oauthTool.serverName,
				);
				tools[oauthTool.name] = tool({
					description: oauthTool.description,
					inputSchema: zodSchema,
					execute: async (args: Record<string, unknown>) => {
						// Read-only mode: OAuth integration
						// writes (Teams/GitHub) are external writes too.
						const readOnlyBlock = await guardToolWriteForReadOnly(
							projectId,
							oauthTool.originalName,
						);
						if (readOnlyBlock) {
							return readOnlyBlock;
						}
						const authority =
							await ensureSensitiveOperationAuthority({
								userId,
								organizationId,
								providerKey,
								accessLevel,
								providerType: "INTEGRATION",
								providerRefId: oauthTool.configId,
								providerDisplayName: oauthTool.serverName,
								runType: "AGENT_INSTANCE",
								runId: executionId,
								toolName: oauthTool.originalName,
							});

						if (!authority.authorized) {
							return buildAuthorityRequiredResult({
								providerKey,
								accessLevel,
								displayName: oauthTool.serverName,
								action: authority.action,
								pendingSessionId: authority.pendingSessionId,
								reason: authority.reason,
							});
						}

						try {
							return await oauthTool.execute(args);
						} catch (err) {
							logger.error(
								`[AgentExecutor] OAuth tool execution failed: ${oauthTool.name}`,
								{
									error:
										err instanceof Error
											? err.message
											: String(err),
									toolName: oauthTool.name,
									serverName: oauthTool.serverName,
								},
							);
							throw err;
						}
					},
				} as unknown as Parameters<typeof tool>[0]);
				toolToConfig[oauthTool.name] = {
					configId: oauthTool.configId,
					serverName: oauthTool.serverName,
					originalName: oauthTool.originalName,
				};
			}
			logger.info("[AgentExecutor] OAuth integration tools loaded", {
				oauthToolCount: oauthTools.length,
			});
		}

		// Load built-in Fabric AI tools if configured
		if (builtInToolNames && builtInToolNames.length > 0) {
			const builtInTools = await loadBuiltInToolsForAgent(
				builtInToolNames,
				userId,
				organizationId,
				imageRefs,
				agentInstanceId,
				callingAgentId,
				currentDepth,
				projectId,
			);
			for (const [name, def] of Object.entries(builtInTools)) {
				tools[name] = def;
				toolToConfig[name] = {
					configId: "builtin",
					serverName: "fabric-ai",
					originalName: name,
				};
			}
			logger.info("[AgentExecutor] Built-in tools loaded", {
				builtInToolCount: Object.keys(builtInTools).length,
				toolNames: Object.keys(builtInTools),
			});
		}

		const hasTools = Object.keys(tools).length > 0;
		logger.info("[AgentExecutor] Tools loaded", {
			toolCount: Object.keys(tools).length,
			hasTools,
		});

		// Build the full system prompt with knowledge context
		const fullSystemPrompt = buildFullSystemPrompt(
			systemPrompt,
			knowledgeContext,
		);

		// Build conversation messages (async when images are present)
		const messages = await buildConversationMessages(
			conversationHistory,
			userMessage,
			imageRefs,
		);

		// Get AI model - use override if provided, otherwise use dynamic selection
		const aiModel = model
			? await getModelWithOverride(model, userId, organizationId)
			: await getAiModel(userId, organizationId, hasTools);

		// Send initial heartbeat
		heartbeat({ phase: "executing", toolCalls: [] });

		// Execute with or without tools
		let responseText: string;
		let stepNumber = 0;

		// Track token usage
		let tokenUsage: ExecuteAgentTurnResult["tokenUsage"];

		if (hasTools) {
			const stream = streamText({
				model: aiModel,
				stopWhen: stepCountIs(maxIterations),
				system: fullSystemPrompt,
				messages: messages as any,
				tools: tools as any,
				abortSignal: Context.current().cancellationSignal,
				onChunk: ({
					chunk,
				}: {
					chunk: { type: string; text?: string };
				}) => {
					logger.info("[AgentExecutor] onChunk", {
						chunkType: chunk.type,
						hasText: !!chunk.text,
						executionId,
					});
					if (
						executionId &&
						chunk.type === "text-delta" &&
						chunk.text
					) {
						publishExecutionEvent(executionId, {
							event: "execution.text_delta",
							data: { text: chunk.text },
						});
					}
				},
				onStepFinish: (stepResult: unknown) => {
					stepNumber++;
					const step = stepResult as {
						toolCalls?: Array<{
							toolName: string;
							toolCallId: string;
							input?: unknown;
						}>;
						toolResults?: Array<{
							toolCallId: string;
							output?: unknown;
						}>;
						text?: string;
					};

					if (step.toolCalls && step.toolCalls.length > 0) {
						for (const tc of step.toolCalls) {
							const matchingResult = step.toolResults?.find(
								(r) => r.toolCallId === tc.toolCallId,
							);
							const configInfo = toolToConfig[tc.toolName];

							const isError =
								!matchingResult ||
								isErrorResult(matchingResult?.output);

							toolCalls.push({
								id: tc.toolCallId,
								name: tc.toolName,
								serverName: configInfo?.serverName,
								args:
									(tc.input as Record<string, unknown>) || {},
								result: matchingResult?.output,
								status: isError ? "error" : "success",
								durationMs: Date.now() - startTime,
							});

							// Publish tool call events in real-time via Redis
							if (executionId) {
								publishExecutionEvent(executionId, {
									event: "execution.tool_call_completed",
									data: {
										toolName: tc.toolName,
										toolCallId: tc.toolCallId,
										status: isError ? "error" : "success",
									},
								});
							}
						}

						heartbeat({
							phase: "executing",
							toolCalls: toolCalls.map((tc) => ({
								id: tc.id,
								name: tc.name,
								status: tc.status,
							})),
						});
					}

					logger.info("[AgentExecutor] Step completed", {
						step: stepNumber,
						toolCallsThisStep: step.toolCalls?.length ?? 0,
						totalToolCalls: toolCalls.length,
					});
				},
			});

			// Await full result - streamText properties are PromiseLike
			const result = await stream;
			responseText = (await result.text) || "Task completed.";
			const usage = await result.usage;
			tokenUsage = extractTokenUsage({ usage });
		} else {
			// No tools - simple text generation with streaming
			const stream = streamText({
				model: aiModel,
				system: fullSystemPrompt,
				messages: messages as any,
				abortSignal: Context.current().cancellationSignal,
				onChunk: ({
					chunk,
				}: {
					chunk: { type: string; text?: string };
				}) => {
					if (
						executionId &&
						chunk.type === "text-delta" &&
						chunk.text
					) {
						publishExecutionEvent(executionId, {
							event: "execution.text_delta",
							data: { text: chunk.text },
						});
					}
				},
			});

			const result = await stream;
			responseText = (await result.text) || "Task completed.";
			const usage = await result.usage;
			tokenUsage = extractTokenUsage({ usage });
		}

		const durationMs = Date.now() - startTime;

		logger.info("[AgentExecutor] Agent turn completed", {
			responseLength: responseText.length,
			toolCallCount: toolCalls.length,
			durationMs,
			steps: stepNumber,
		});

		return {
			response: responseText,
			toolCalls,
			tokenUsage,
			success: true,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[AgentExecutor] Agent turn failed", {
			error: errorMessage,
		});

		return {
			response: "",
			toolCalls,
			success: false,
			error: errorMessage,
		};
	}
}

/**
 * Load MCP tools for agent execution.
 * Exported so sub-agent runners can load the same tools for delegated agents.
 */
export async function loadMcpToolsForAgent(
	mcpConfigIds: string[],
	userId: string,
	organizationId?: string,
): Promise<{
	tools: Record<string, unknown>;
	toolToConfig: Record<string, McpToolInfo>;
}> {
	const allTools: Record<string, unknown> = {};
	const toolToConfig: Record<string, McpToolInfo> = {};

	// Build tenant filter for strict isolation
	// In org context: only org configs, in personal context: only personal configs
	const tenantFilter = organizationId
		? { organizationId, userId }
		: { organizationId: null, userId };

	if (mcpConfigIds.length === 0) {
		// No MCP configs specified — return without loading any tools
		logger.info(
			"[AgentExecutor] No MCP config IDs provided, skipping tool loading",
		);
		return { tools: allTools, toolToConfig };
	}

	// Load MCP configs with tenant isolation
	// CRITICAL: Always filter by tenant even when IDs are provided to prevent
	// accessing configs from other users/orgs via ID enumeration
	const configs = await db.mCPConfig.findMany({
		where: {
			id: { in: mcpConfigIds },
			...tenantFilter,
			enabled: true,
		},
		include: { mcpServer: true },
	});

	logger.info("[AgentExecutor] Loading MCP tools", {
		requestedCount: mcpConfigIds.length,
		foundCount: configs.length,
	});

	// Build redirect URI for OAuth2 support
	const baseUrl = getBaseUrl();
	const redirectUri = `${baseUrl}/api/mcp/oauth/callback`;

	// Load tools from each config in parallel
	const loadStartTime = Date.now();
	const loadResults = await Promise.allSettled(
		configs.map(async (config) => {
			try {
				const result = await getCachedMcpClientForConfig({
					configId: config.id,
					userId,
					organizationId,
					redirectUri, // Enable OAuth2 token refresh
				});

				if (result) {
					const tools = await result.client.tools();
					return { config, result, tools };
				}
				return null;
			} catch (e) {
				// Handle OAuth authorization required errors specially
				if (e instanceof OAuthAuthorizationRequiredError) {
					logger.warn(
						`[AgentExecutor] OAuth authorization required for ${config.displayName}`,
						{ configId: config.id, serverName: e.serverName },
					);
				} else {
					logger.warn(
						`[AgentExecutor] Failed to connect to ${config.displayName}`,
						{
							error: e instanceof Error ? e.message : String(e),
						},
					);
				}
				return null;
			}
		}),
	);

	logger.info(
		`[AgentExecutor] MCP load completed in ${Date.now() - loadStartTime}ms`,
	);

	// Process results
	for (const loadResult of loadResults) {
		if (loadResult.status === "fulfilled" && loadResult.value) {
			const { config, result, tools } = loadResult.value;
			const toolNames = Object.keys(tools);
			logger.info(
				`[AgentExecutor] Loaded ${toolNames.length} tools from ${result.serverName}`,
			);

			for (const [name, def] of Object.entries(tools)) {
				allTools[name] = def;
				toolToConfig[name] = {
					configId: config.id,
					serverName: result.serverName,
					originalName: name,
				};
			}
		}
	}

	return { tools: allTools, toolToConfig };
}

/**
 * Built-in tool name → Fabric AI tool ID mapping
 * Matches BUILT_IN_TO_FABRIC_TOOLS in agent-templates.ts
 */
const BUILT_IN_TOOL_MAP: Record<string, string[]> = {
	"create-frames": [
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_get_frame",
		"fabric_list_frames",
		"fabric_share_frame",
		"fabric_create_slideshow",
	],
	"create-images": ["fabric_generate_image"],
	"image-generation": ["fabric_generate_image"],
	"speech-generator": ["fabric_text_to_speech"],
	"web-search": [
		"fabric_web_search",
		"fabric_scrape_url",
		"fabric_search_and_analyze",
		"fabric_scrape_and_analyze",
	],
	"web-search-browse": [
		"fabric_web_search",
		"fabric_scrape_url",
		"fabric_search_and_analyze",
		"fabric_scrape_and_analyze",
	],
};

/**
 * Load built-in Fabric AI tools for agent execution.
 *
 * These tools are not backed by MCP servers but are native capabilities
 * (e.g., image generation). The tool implementations call the corresponding
 * activity functions directly.
 */
async function loadBuiltInToolsForAgent(
	builtInToolNames: string[],
	userId: string,
	organizationId?: string,
	imageRefs?: Array<{ storagePath: string; mimeType: string; name: string }>,
	agentInstanceId?: string,
	callingAgentId?: string,
	currentDepth = 0,
	projectId?: string,
): Promise<Record<string, unknown>> {
	const tools: Record<string, unknown> = {};
	const fabricToolDefinitions = getFabricToolDefinitionMap(
		getAllFabricAiTools(),
	);

	// Resolve built-in names to Fabric AI tool IDs
	const fabricToolIds = new Set<string>();
	for (const name of builtInToolNames) {
		const ids = BUILT_IN_TOOL_MAP[name];
		if (ids) {
			for (const id of ids) {
				fabricToolIds.add(id);
			}
		}

		if (name === "run-agent") {
			tools.run_agent = createRunAgentTool(
				callingAgentId || agentInstanceId || "agent",
				currentDepth,
				userId,
				organizationId,
				[],
			);
		}

		if (name === "agent-memory" && agentInstanceId) {
			for (const memoryTool of getAgentMemoryTools()) {
				tools[memoryTool.name] = tool({
					description: memoryTool.description,
					inputSchema: memoryTool.schema,
					execute: async (args: Record<string, unknown>) =>
						memoryTool.execute(
							{
								agentInstanceId,
								userId,
								organizationId,
							},
							args,
						),
				} as unknown as Parameters<typeof tool>[0]);
			}
		}
	}

	if (fabricToolIds.size === 0) {
		return tools;
	}

	// Create tool implementations for each resolved ID
	for (const toolId of fabricToolIds) {
		const toolDefinition = fabricToolDefinitions.get(toolId);
		if (!toolDefinition?.inputSchema) {
			continue;
		}

		if (toolId === "fabric_web_search") {
			tools.fabric_web_search = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { searchWebActivity } = await import("../fabric-ai");
					const result = await searchWebActivity({
						question: (args.query as string) || "",
						userId,
						organizationId,
					});

					return result.success
						? {
								results: result.results,
								durationMs: result.durationMs,
							}
						: { error: result.error || "Web search failed" };
				},
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_scrape_url") {
			tools.fabric_scrape_url = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { scrapeUrlActivity } = await import("../fabric-ai");
					const result = await scrapeUrlActivity({
						url: (args.url as string) || "",
						userId,
						organizationId,
					});

					return result.success
						? {
								content: result.content,
								durationMs: result.durationMs,
							}
						: { error: result.error || "URL scrape failed" };
				},
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_search_and_analyze") {
			tools.fabric_search_and_analyze = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { searchAndAnalyzeActivity } = await import(
						"../fabric-ai"
					);
					const result = await searchAndAnalyzeActivity({
						question: (args.query as string) || "",
						pattern: ((args.pattern as string) ||
							"summarize") as any,
						userId,
						organizationId,
						projectId,
					});

					return result.success
						? {
								analysis: result.analysis,
								durationMs: result.durationMs,
								metadata: result.metadata,
							}
						: {
								error:
									result.error || "Search and analyze failed",
							};
				},
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_scrape_and_analyze") {
			tools.fabric_scrape_and_analyze = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { scrapeAndAnalyzeActivity } = await import(
						"../fabric-ai"
					);
					const result = await scrapeAndAnalyzeActivity({
						url: (args.url as string) || "",
						pattern: ((args.pattern as string) ||
							"summarize") as any,
						userId,
						organizationId,
						projectId,
					});

					return result.success
						? {
								analysis: result.analysis,
								durationMs: result.durationMs,
								metadata: result.metadata,
							}
						: {
								error:
									result.error || "Scrape and analyze failed",
							};
				},
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_text_to_speech") {
			tools.fabric_text_to_speech = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const ttsText = (args.text as string) || "";
					const ttsVoice = (args.voice as string) || "alloy";
					const ttsSpeed = (args.speed as number) || 1.0;

					if (!ttsText) {
						return {
							error: "Text is required for speech generation",
						};
					}

					const { uploadFile } = await import("@repo/storage");
					// This path calls OpenAI's TTS endpoint directly, so it needs the
					// tenant's OpenAI key specifically, decrypted — not whichever
					// provider the tenant's default model selection resolved to.
					const openAiApiKey = await resolveOpenAiApiKey({
						userId,
						organizationId,
					});

					if (!openAiApiKey) {
						return {
							error: "No OpenAI API key configured for text-to-speech",
						};
					}

					const response = await fetch(
						"https://api.openai.com/v1/audio/speech",
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${openAiApiKey}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								model: "tts-1",
								input: ttsText.substring(0, 4096),
								voice: ttsVoice,
								speed: Math.min(4.0, Math.max(0.25, ttsSpeed)),
								response_format: "mp3",
							}),
						},
					);

					if (!response.ok) {
						return {
							error: `TTS API error ${response.status}: ${await response.text()}`,
						};
					}

					const audioBuffer = Buffer.from(
						await response.arrayBuffer(),
					);
					const audioKey = `tts/${userId}/${Date.now()}.mp3`;
					await uploadFile(audioKey, audioBuffer, {
						bucket:
							process.env
								.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME ||
							"chat-documents",
						contentType: "audio/mpeg",
					});

					const orgParam = organizationId
						? `&orgId=${encodeURIComponent(organizationId)}`
						: "";
					const audioUrl = `/api/storage/image?path=${encodeURIComponent(audioKey)}${orgParam}`;
					const wordCount = ttsText.split(/\s+/).length;

					return {
						audioUrl,
						format: "mp3",
						durationSeconds: Math.round(
							(wordCount / 150) * 60 * (1 / ttsSpeed),
						),
						response: "Audio generated successfully.",
					};
				},
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_create_frame") {
			tools.fabric_create_frame = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					createFirstClassFrame({ args, userId, organizationId }),
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_create_slideshow") {
			tools.fabric_create_slideshow = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					createFirstClassFrame({
						args: { ...args, kind: "slideshow" },
						userId,
						organizationId,
					}),
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_update_frame") {
			tools.fabric_update_frame = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					updateFirstClassFrame({ args, userId, organizationId }),
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_get_frame") {
			tools.fabric_get_frame = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					getFirstClassFrame({ args, userId, organizationId }),
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_list_frames") {
			tools.fabric_list_frames = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async () =>
					listFirstClassFrames({ userId, organizationId }),
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_share_frame") {
			tools.fabric_share_frame = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					shareFirstClassFrame({ args, userId, organizationId }),
			} as unknown as Parameters<typeof tool>[0]);
			continue;
		}

		if (toolId === "fabric_generate_image") {
			tools.fabric_generate_image = tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { generateImageActivity } = await import(
						"../image-generation"
					);

					const prompt = (args.prompt as string) || "";
					const provider =
						(args.provider as "gateway" | "fal" | "gemini") ||
						"gateway";
					// Use S3 storage path from args, fall back to first attached image
					const rawInputImage =
						(args.inputImage as string) || undefined;
					const inputImagePath =
						rawInputImage && !rawInputImage.startsWith("http")
							? rawInputImage
							: imageRefs?.[0]?.storagePath || undefined;

					if (!prompt) {
						return {
							error: "Prompt is required for image generation",
						};
					}

					const imageResult = await generateImageActivity({
						prompt,
						provider,
						aspectRatio: (args.aspectRatio as string) || "1:1",
						quality: (args.quality as string) || "medium",
						model: args.model as string | undefined,
						inputImagePath,
						gatewayModel: args.gatewayModel as string | undefined,
						userId,
						organizationId,
					});

					if (!imageResult.success) {
						return {
							error:
								imageResult.error || "Image generation failed",
						};
					}

					// Build proxy URL for stable image display
					const orgParam = organizationId
						? `&orgId=${encodeURIComponent(organizationId)}`
						: "";
					const imageDisplayUrl = imageResult.storagePath
						? `/api/storage/image?path=${encodeURIComponent(imageResult.storagePath)}${orgParam}`
						: imageResult.imageUrl;

					return {
						imageUrl: imageDisplayUrl,
						storagePath: imageResult.storagePath,
						mimeType: "image/png",
						name: "generated-image.png",
						text: imageResult.text,
						width: imageResult.width,
						height: imageResult.height,
						provider: imageResult.provider,
						model: imageResult.model,
					};
				},
			} as unknown as Parameters<typeof tool>[0]);

			logger.info(
				"[AgentExecutor] Built-in fabric_generate_image tool created",
			);
		}
	}

	return tools;
} // end loadMcpToolsForAgent

/**
 * Build the full system prompt with knowledge context
 */
function buildFullSystemPrompt(
	basePrompt: string,
	knowledgeContext?: string,
): string {
	const parts: string[] = [basePrompt];

	if (knowledgeContext && knowledgeContext.trim().length > 0) {
		parts.push(`\n\n${knowledgeContext}`);
	}

	return parts.join("");
}

/**
 * Build conversation messages for the AI.
 * When imageRefs are present, downloads images from S3 and builds
 * multimodal content parts for the current user message.
 */
async function buildConversationMessages(
	history: Array<{ role: "user" | "assistant"; content: string }>,
	currentMessage: string,
	imageRefs?: Array<{
		storagePath: string;
		mimeType: string;
		name: string;
	}>,
): Promise<
	Array<{
		role: "user" | "assistant";
		content: string | Array<{ type: string; [k: string]: unknown }>;
	}>
> {
	const messages: Array<{
		role: "user" | "assistant";
		content: string | Array<{ type: string; [k: string]: unknown }>;
	}> = [...history];

	if (imageRefs && imageRefs.length > 0) {
		// Download images from S3 and build multimodal content
		const { downloadFile } = await import("@repo/storage");
		const { config } = await import("@repo/config");
		const bucket = config.storage.bucketNames.chatDocuments;

		// Append storage path info so the LLM can pass it to fabric_generate_image
		const storagePaths = imageRefs.map((r) => r.storagePath).join(", ");
		const messageWithPaths =
			`${currentMessage}\n\n[ATTACHED IMAGES: ${imageRefs.length} image(s). ` +
			`Storage paths: ${storagePaths}. ` +
			"When calling fabric_generate_image for image editing, pass the storage path as the inputImage parameter.]";

		const contentParts: Array<{ type: string; [k: string]: unknown }> = [
			{ type: "text", text: messageWithPaths },
		];

		for (const ref of imageRefs) {
			try {
				const { data } = await downloadFile(ref.storagePath, {
					bucket,
				});
				const base64 = data.toString("base64");
				const dataUrl = `data:${ref.mimeType};base64,${base64}`;

				contentParts.push({
					type: "image",
					image: dataUrl,
				});
			} catch (err) {
				logger.warn(
					"[AgentExecutor] Failed to download image for multimodal input",
					{
						storagePath: ref.storagePath,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}

		messages.push({ role: "user", content: contentParts });
	} else {
		messages.push({ role: "user", content: currentMessage });
	}

	return messages;
}

/**
 * Check if a tool result indicates an error.
 * Only checks structural error indicators (error fields, success=false),
 * NOT string content which may contain "error" in normal data.
 */
function isErrorResult(result: unknown): boolean {
	if (!result) {
		return true;
	}

	// For string results, only flag as error if the ENTIRE string looks like an error message
	// (short string starting with error-like patterns), not if it merely contains the word "error"
	if (typeof result === "string") {
		const trimmed = result.trim();
		// Only flag short strings that are clearly error messages
		if (trimmed.length < 200) {
			const lower = trimmed.toLowerCase();
			return (
				lower.startsWith("error") ||
				lower.startsWith("failed") ||
				lower.startsWith("invalid")
			);
		}
		return false;
	}

	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;
		// Check for explicit error field (string or truthy object)
		if (typeof obj.error === "string" && obj.error.length > 0) {
			return true;
		}
		if (typeof obj.Error === "string" && (obj.Error as string).length > 0) {
			return true;
		}
		if (obj.success === false) {
			return true;
		}
	}

	return false;
}

/**
 * Get model with user override - uses centralized AI model access
 *
 * When an explicit model name is provided, we use the centralized getAIModel
 * with modelOverride option to respect user's provider configuration.
 */
async function getModelWithOverride(
	modelName: string,
	userId: string,
	organizationId?: string,
) {
	const { getAIModel } = await import("@repo/ai");

	// Use centralized single entry point with model override
	return getAIModel(
		{ taskType: "COMPLEX", modelOverride: modelName },
		{ userId, organizationId },
	);
}

/**
 * Extract token usage from generateText result
 */
function extractTokenUsage(result: {
	usage?: { inputTokens?: number; outputTokens?: number };
}): ExecuteAgentTurnResult["tokenUsage"] {
	if (!result.usage) {
		return undefined;
	}

	const inputTokens = result.usage.inputTokens ?? 0;
	const outputTokens = result.usage.outputTokens ?? 0;

	if (inputTokens === 0 && outputTokens === 0) {
		return undefined;
	}

	return {
		inputTokens,
		outputTokens,
	};
}

/**
 * OAuth tool info for agent execution
 */
interface OAuthToolInfoForAgent {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	configId: string;
	serverName: string;
	originalName: string;
	execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Load tools from OAuth integrations (Microsoft Teams, GitHub) for agent execution.
 * Checks WorkflowIntegration table for active connections and loads tool definitions
 * from @repo/mcp-registry.
 */
async function loadOAuthIntegrationToolsForAgent(
	integrationConfigurations: Array<{
		integrationId: string;
		integrationType: string;
		allowedResources?: unknown;
	}>,
	userId: string,
	organizationId?: string,
	projectId?: string,
): Promise<OAuthToolInfoForAgent[]> {
	const tools: OAuthToolInfoForAgent[] = [];

	// Check which integration types are configured
	const hasMicrosoftGraph = integrationConfigurations.some(
		(ic) => ic.integrationType.toUpperCase() === "MICROSOFT_GRAPH",
	);

	if (hasMicrosoftGraph) {
		// Check for active Microsoft Teams OAuth connection
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
			try {
				const { MICROSOFT_TEAMS_ACCOUNT } = (await import(
					"@repo/mcp-registry"
				)) as { MICROSOFT_TEAMS_ACCOUNT: AccountDefinition };

				for (const mcp of MICROSOFT_TEAMS_ACCOUNT.mcps) {
					if (mcp.available === false) {
						continue;
					}

					const serverName = mcp.serverName || mcp.name;
					if (mcp.tools) {
						for (const mcpTool of mcp.tools) {
							const toolName = `${serverName}__${mcpTool.name}`;
							const originalToolName = mcpTool.name;
							tools.push({
								name: toolName,
								description: mcpTool.description || "",
								inputSchema: (mcpTool.inputSchema as Record<
									string,
									unknown
								>) || { type: "object" },
								configId: `microsoft-teams-connected:${MICROSOFT_TEAMS_ACCOUNT.id}:${mcp.id}`,
								serverName,
								originalName: originalToolName,
								execute: async (
									args: Record<string, unknown>,
								) => {
									return executeMicrosoftTeamsTool(
										originalToolName,
										args,
										userId,
										organizationId,
									);
								},
							});
						}
					}
				}
				logger.info(
					"[AgentExecutor] Loaded Microsoft Teams OAuth tools",
					{ toolCount: tools.length },
				);
			} catch (e) {
				logger.warn(
					"[AgentExecutor] Failed to load Microsoft Teams tools from registry",
					{ error: e instanceof Error ? e.message : String(e) },
				);
			}
		} else {
			logger.warn(
				"[AgentExecutor] Microsoft Graph integration configured but no active OAuth connection found",
				{ userId, organizationId },
			);
		}
	}

	// Databricks knowledge bindings come from TWO sources: the agent's own
	// integration configurations AND the project-level binding (when this
	// turn runs in a project). Merged per integration and named with the
	// shared suffix rule — previously each config pushed a hardcoded,
	// unsuffixed "search_databricks_indexes", so with 2+ bindings later
	// entries silently overwrote earlier ones in the caller's keyed record
	// and some bound indexes became unreachable with no warning.
	const agentDatabricksBindings: AgentDatabricksBinding[] =
		integrationConfigurations.flatMap((config) => {
			if (
				config.integrationType.toUpperCase() !==
				"DATABRICKS_VECTOR_SEARCH"
			) {
				return [];
			}
			const resources = config.allowedResources as
				| { schema?: string; indexes?: string[] }
				| null
				| undefined;
			const indexNames = (resources?.indexes ?? []).filter(
				(indexName): indexName is string =>
					typeof indexName === "string" && indexName.length > 0,
			);
			if (indexNames.length === 0) {
				logger.warn(
					"[AgentExecutor] Databricks binding has no selected indexes; skipping tool",
					{ integrationId: config.integrationId },
				);
				return [];
			}
			return [
				{
					integrationId: config.integrationId,
					schema: resources?.schema ?? "unknown",
					indexNames,
				},
			];
		});

	let projectDatabricksBinding: AgentDatabricksBinding | null = null;
	if (projectId) {
		try {
			projectDatabricksBinding =
				await loadProjectDatabricksKnowledgeBinding({
					projectId,
					userId,
					organizationId,
				});
		} catch (e) {
			logger.warn(
				"[AgentExecutor] Failed to load project Databricks knowledge binding",
				{
					projectId,
					error: e instanceof Error ? e.message : String(e),
				},
			);
		}
	}

	const databricksBindings = mergeDatabricksBindings([
		...agentDatabricksBindings,
		...(projectDatabricksBinding ? [projectDatabricksBinding] : []),
	]);

	for (const [index, binding] of databricksBindings.entries()) {
		const { integrationId, schema, indexNames } = binding;
		tools.push({
			name: databricksKnowledgeToolName(index),
			description: `Search the team's Databricks vector knowledge base (schema ${schema}; indexes: ${indexNames.join(", ")}). Use for questions about the indexed corpus; returns relevant text chunks with similarity scores.`,
			inputSchema: {
				type: "object",
				required: ["query"],
				properties: {
					query: {
						type: "string",
						description: "Natural-language search query",
					},
					num_results: {
						type: "number",
						description: "Max chunks to return (default 8)",
					},
				},
			},
			configId: `databricks-vector-search:${integrationId}`,
			serverName: "databricks-vector-search",
			originalName: "search_databricks_indexes",
			execute: async (args: Record<string, unknown>) =>
				executeDatabricksBindingSearch(
					{ integrationId, indexNames },
					args,
					{ userId, organizationId },
				),
		});
	}

	return tools;
}

/**
 * Preview input — same as ExecuteAgentTurnInput but without Temporal-specific fields.
 * Used from the API layer for live preview without running a full Temporal workflow.
 */
export interface PreviewAgentTurnInput {
	systemPrompt: string;
	userMessage: string;
	mcpConfigIds?: string[];
	model?: string;
	userId: string;
	organizationId?: string;
	maxIterations?: number;
	builtInToolNames?: string[];
	/** Timeout in ms for the preview (default 30s) */
	timeoutMs?: number;
}

export interface PreviewAgentTurnResult {
	response: string;
	success: boolean;
	error?: string;
}

/**
 * Run a single agent turn for live preview purposes.
 *
 * Identical to executeAgentTurn but without Temporal-specific APIs (heartbeat,
 * cancellationSignal, event publishing). Safe to call from any async context.
 *
 * AUTHORIZATION: Caller must pass an authenticated userId + organizationId.
 */
export async function previewAgentTurn(
	input: PreviewAgentTurnInput,
): Promise<PreviewAgentTurnResult> {
	const {
		systemPrompt,
		userMessage,
		mcpConfigIds,
		model,
		userId,
		organizationId,
		maxIterations = 5,
		builtInToolNames,
		timeoutMs = 30_000,
	} = input;

	logger.info("[AgentPreview] Starting preview turn", {
		mcpConfigCount: mcpConfigIds?.length ?? 0,
		builtInToolCount: builtInToolNames?.length ?? 0,
		maxIterations,
	});

	try {
		const abortController = new AbortController();
		const timer = setTimeout(() => abortController.abort(), timeoutMs);

		// Load MCP tools
		const { tools } = await loadMcpToolsForAgent(
			mcpConfigIds || [],
			userId,
			organizationId,
		);

		// Load built-in tools (no agentInstanceId / callingAgentId for preview)
		if (builtInToolNames && builtInToolNames.length > 0) {
			const builtInTools = await loadBuiltInToolsForAgent(
				builtInToolNames,
				userId,
				organizationId,
			);
			for (const [name, def] of Object.entries(builtInTools)) {
				tools[name] = def;
			}
		}

		const hasTools = Object.keys(tools).length > 0;
		const fullSystemPrompt = buildFullSystemPrompt(systemPrompt);
		const messages = await buildConversationMessages([], userMessage);

		const aiModel = model
			? await getModelWithOverride(model, userId, organizationId)
			: await getAiModel(userId, organizationId, hasTools);

		let responseText: string;

		if (hasTools) {
			const stream = streamText({
				model: aiModel,
				stopWhen: stepCountIs(maxIterations),
				system: fullSystemPrompt,
				messages: messages as any,
				tools: tools as any,
				abortSignal: abortController.signal,
			});
			const result = await stream;
			responseText = (await result.text) || "Task completed.";
		} else {
			const stream = streamText({
				model: aiModel,
				system: fullSystemPrompt,
				messages: messages as any,
				abortSignal: abortController.signal,
			});
			const result = await stream;
			responseText = (await result.text) || "Task completed.";
		}

		clearTimeout(timer);
		return { response: responseText, success: true };
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[AgentPreview] Preview turn failed", {
			error: errorMessage,
		});
		return { response: "", success: false, error: errorMessage };
	}
}
