/**
 * Unified Server for Prompt Enhancer
 *
 * Single server that handles both AG-UI (CopilotKit) and A2A (orchestrator) protocols.
 * This replaces the need for separate AG-UI and A2A servers.
 *
 * Endpoints:
 * - AG-UI: /invoke, /stream, /ok (for CopilotKit frontend)
 * - LangGraph Platform API: /runs/stream, /threads/:id/runs/stream (for CopilotKit LangGraphAgent)
 * - A2A: /.well-known/agent.json, /a2a/send, /health (for orchestrator)
 */

import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import {
	type AgentRuntimeConfig,
	type AgentSkill,
	createUnifiedServer,
	type LangGraphStreamEvent,
	PredictiveToolArgsAccumulator,
} from "@repo/agent-core";
import { v4 as uuidv4 } from "uuid";
import { promptEnhancerGraph } from "./agent.js";
import type { EnhancementType, PromptCategory, PromptFormat } from "./types.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils";

/**
 * Normalize messages from CopilotKit format to LangChain BaseMessage format
 * CopilotKit uses camelCase (toolCallId) while LangChain expects snake_case (tool_call_id)
 * CopilotKit uses 'type' property while LangChain uses 'role'
 *
 * IMPORTANT: CopilotKit sometimes sends AI messages without tool_calls, followed by
 * ToolMessages that reference those calls. OpenAI requires ToolMessages to be preceded
 * by an AIMessage with matching tool_calls. This function reconstructs missing tool_calls.
 */

/**
 * Parse tool call arguments from various formats.
 * Handles OpenAI format (function.arguments as JSON string) and LangChain format (args as object).
 */
function parseToolCallArgs(
	tc: Record<string, unknown>,
): Record<string, unknown> {
	let args = tc.args;
	if (!args && tc.function) {
		args = (tc.function as Record<string, unknown>)?.arguments;
	}
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args);
			if (
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed)
			) {
				return parsed as Record<string, unknown>;
			}
			return {};
		} catch {
			return {};
		}
	}
	if (args && typeof args === "object") {
		return args as Record<string, unknown>;
	}
	return {};
}

function normalizeMessages(
	messages: Array<Record<string, unknown>>,
): BaseMessage[] {
	// Debug: Log raw messages to understand what CopilotKit sends
	console.log(
		"[UnifiedServer] Raw messages from CopilotKit:",
		messages.map((msg, i) => ({
			index: i,
			type: msg.type,
			role: msg.role,
			hasToolCalls: !!(msg.tool_calls || msg.toolCalls),
			toolCallsCount:
				((msg.tool_calls || msg.toolCalls) as Array<unknown>)?.length ||
				0,
			hasToolCallId: !!(msg.tool_call_id || msg.toolCallId),
			toolCallId: msg.tool_call_id || msg.toolCallId,
			contentPreview:
				typeof msg.content === "string"
					? msg.content.substring(0, 100)
					: JSON.stringify(msg.content)?.substring(0, 100),
		})),
	);

	// First pass: collect tool message IDs and their preceding AI message indices
	// This helps us reconstruct missing tool_calls on AI messages
	const toolMessagesByPrecedingAi = new Map<
		number,
		Array<{ id: string; name: string }>
	>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const msgType = (
			(msg.type as string) ||
			(msg.role as string) ||
			""
		).toLowerCase();

		if (msgType === "tool") {
			const toolCallId =
				(msg.tool_call_id as string) || (msg.toolCallId as string);
			// Default to confirm_changes for confirmation tools (matches document-generator pattern)
			// This ensures the confirmation flow works correctly
			const toolName = (msg.name as string) || "confirm_changes";

			console.log(`[UnifiedServer] Tool message at index ${i}:`, {
				toolCallId,
				toolName,
			});

			if (toolCallId) {
				// Find the preceding AI message
				for (let j = i - 1; j >= 0; j--) {
					const prevMsg = messages[j];
					const prevType = (
						(prevMsg.type as string) ||
						(prevMsg.role as string) ||
						""
					).toLowerCase();
					if (prevType === "ai" || prevType === "assistant") {
						// Check if this AI message already has the tool_call
						// CopilotKit uses camelCase (toolCalls), LangChain uses snake_case (tool_calls)
						const existingToolCalls = (prevMsg.tool_calls ||
							prevMsg.toolCalls) as
							| Array<Record<string, unknown>>
							| undefined;
						console.log(
							`[UnifiedServer] Checking AI message at index ${j}:`,
							{
								hasExistingToolCalls: !!existingToolCalls,
								existingToolCallsCount:
									existingToolCalls?.length || 0,
								existingToolCalls: existingToolCalls?.map(
									(tc) => ({
										id: tc.id,
										name: tc.name,
										functionName: (
											tc.function as Record<
												string,
												unknown
											>
										)?.name,
									}),
								),
							},
						);

						const hasToolCall = existingToolCalls?.some(
							(tc) =>
								(tc.id as string) === toolCallId ||
								(tc.name as string) === toolName ||
								((tc.function as Record<string, unknown>)
									?.name as string) === toolName,
						);

						if (!hasToolCall) {
							// This AI message needs a reconstructed tool_call
							if (!toolMessagesByPrecedingAi.has(j)) {
								toolMessagesByPrecedingAi.set(j, []);
							}
							toolMessagesByPrecedingAi
								.get(j)
								?.push({ id: toolCallId, name: toolName });
							console.log(
								`[UnifiedServer] Will reconstruct tool_call for AI at index ${j}:`,
								{ toolCallId, toolName },
							);
						} else {
							console.log(
								`[UnifiedServer] AI at index ${j} already has matching tool_call`,
							);
						}
						break;
					}
				}
			}
		}
	}

	if (toolMessagesByPrecedingAi.size > 0) {
		console.log(
			"[UnifiedServer] Reconstructing tool_calls for AI messages:",
			Array.from(toolMessagesByPrecedingAi.entries()).map(
				([idx, calls]) => ({
					aiMessageIndex: idx,
					toolCalls: calls,
				}),
			),
		);
	} else {
		console.log("[UnifiedServer] No tool_calls need reconstruction");
	}

	// Second pass: convert messages, adding reconstructed tool_calls where needed
	return messages.map((msg, index) => {
		const content =
			typeof msg.content === "string"
				? msg.content
				: String(msg.content || "");

		// Determine message type from 'type' or 'role'
		const msgType = (msg.type as string) || (msg.role as string) || "user";

		// Convert toolCallId (camelCase) to tool_call_id (snake_case)
		const toolCallId =
			(msg.tool_call_id as string) || (msg.toolCallId as string);

		// Create appropriate LangChain message type
		switch (msgType.toLowerCase()) {
			case "human":
			case "user":
				return new HumanMessage({ content });

			case "ai":
			case "assistant": {
				// AI messages may have tool_calls
				// CopilotKit uses camelCase (toolCalls), LangChain uses snake_case (tool_calls)
				const toolCalls = (msg.tool_calls || msg.toolCalls) as
					| Array<Record<string, unknown>>
					| undefined;

				// Check if we need to reconstruct tool_calls for this AI message
				const reconstructedCalls = toolMessagesByPrecedingAi.get(index);
				if (reconstructedCalls && reconstructedCalls.length > 0) {
					// Merge existing tool_calls with reconstructed ones
					const existingCalls =
						toolCalls?.map((tc) => ({
							id: (tc.id as string) || "",
							name:
								(tc.name as string) ||
								((tc.function as Record<string, unknown>)
									?.name as string) ||
								"",
							args: parseToolCallArgs(tc),
							type: "tool_call" as const,
						})) || [];

					const newCalls = reconstructedCalls.map((rc) => ({
						id: rc.id,
						name: rc.name,
						args: {},
						type: "tool_call" as const,
					}));

					return new AIMessage({
						content,
						tool_calls: [...existingCalls, ...newCalls],
					});
				}

				if (toolCalls && toolCalls.length > 0) {
					return new AIMessage({
						content,
						tool_calls: toolCalls.map((tc) => ({
							id: (tc.id as string) || "",
							name:
								(tc.name as string) ||
								((tc.function as Record<string, unknown>)
									?.name as string) ||
								"",
							args: parseToolCallArgs(tc),
							type: "tool_call" as const,
						})),
					});
				}
				return new AIMessage({ content });
			}

			case "system":
				return new SystemMessage({ content });

			case "tool":
				if (!toolCallId) {
					console.warn(
						"[UnifiedServer] Tool message missing tool_call_id, using placeholder",
					);
				}
				return new ToolMessage({
					content,
					tool_call_id: toolCallId || "unknown",
				});

			default:
				console.warn(
					`[UnifiedServer] Unknown message type: ${msgType}, treating as human`,
				);
				return new HumanMessage({ content });
		}
	});
}

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8128", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "enhance-prompt",
		name: "Enhance Prompt",
		description:
			"Improve prompts with better structure, clarity, and context",
		parameters: {
			type: "object",
			properties: {
				currentContent: {
					type: "string",
					description: "The original prompt content to enhance",
				},
				promptName: {
					type: "string",
					description: "Name of the prompt",
				},
				promptDescription: {
					type: "string",
					description: "Description of what the prompt is for",
				},
				enhancementType: {
					type: "string",
					enum: [
						"general",
						"clarity",
						"specificity",
						"conciseness",
						"structure",
					],
					description: "Type of enhancement to apply",
				},
				userInstructions: {
					type: "string",
					description: "Specific instructions for enhancement",
				},
			},
			required: ["currentContent"],
		},
		examples: [
			"Make this prompt clearer and more specific",
			"Add structure and examples to this prompt",
			"Optimize this prompt for better AI responses",
		],
		tags: ["prompt", "enhancement"],
	},
	{
		id: "optimize-prompt",
		name: "Optimize Prompt",
		description:
			"Optimize prompts for specific LLM capabilities and use cases",
		examples: [
			"Optimize this prompt for code generation",
			"Make this prompt work better with Claude",
			"Improve token efficiency of this prompt",
		],
		tags: ["prompt", "optimization"],
	},
];

// Create unified server
const { app, start } = createUnifiedServer(
	{
		name: "prompt_enhancer",
		description:
			"Enhances and optimizes prompts for better AI responses. Best for refining prompts, adding context, and improving clarity for LLM interactions.",
		baseUrl: BASE_URL,
		port: PORT,
		host: HOST,
		skills: AGENT_SKILLS,
		tags: ["prompt", "enhancement", "optimization", "langgraph"],
		supportsStreaming: true, // Enable streaming for CopilotKit
	},
	// Invoke function - wraps the LangGraph graph
	async (input: Record<string, unknown>) => {
		const rawMessages = input.messages as Array<Record<string, unknown>>;
		// Normalize messages from CopilotKit format to LangChain format
		const messages = normalizeMessages(rawMessages);

		// Extract CopilotKit state from body.state
		// CopilotKit sends agent state in body.state, which gets spread into input
		const copilotState = input.state as Record<string, unknown> | undefined;

		// Get currentContent with proper priority:
		// 1. Direct input.currentContent (A2A or direct API)
		// 2. CopilotKit state (body.state.currentContent)
		// 3. NEVER fall back to last message - that's the user's instruction, not the prompt content!
		const currentContent =
			(input.currentContent as string) ||
			(copilotState?.currentContent as string) ||
			"";

		const promptId =
			(input.promptId as string) ||
			(copilotState?.promptId as string) ||
			uuidv4();
		const promptName =
			(input.promptName as string) ||
			(copilotState?.promptName as string) ||
			"Untitled Prompt";
		const promptDescription =
			(input.promptDescription as string | undefined) ||
			(copilotState?.promptDescription as string | undefined);
		const enhancementType = ((input.enhancementType as string) ||
			(copilotState?.enhancementType as string) ||
			"general") as EnhancementType;
		const userInstructions =
			(input.userInstructions as string | undefined) ||
			(copilotState?.userInstructions as string | undefined);
		const format = ((input.format as string) ||
			(copilotState?.format as string) ||
			"PLAIN_TEXT") as PromptFormat;
		const category =
			(input.category as PromptCategory | undefined) ||
			(copilotState?.category as PromptCategory | undefined);
		const tags =
			(input.tags as string[]) || (copilotState?.tags as string[]) || [];

		console.log("[UnifiedServer] Invoking prompt_enhancer with:", {
			messageCount: messages.length,
			contentLength: currentContent.length,
			enhancementType,
			hasUserInstructions: !!userInstructions,
			// Log normalized messages for debugging - use _getType() for LangChain message types
			normalizedMessages: messages.map((m) => ({
				messageType: m._getType(),
				hasToolCalls:
					"tool_calls" in m && !!(m as AIMessage).tool_calls?.length,
				hasToolCallId: "tool_call_id" in m,
				contentPreview:
					typeof m.content === "string"
						? m.content.substring(0, 50)
						: String(m.content).substring(0, 50),
			})),
		});

		// Invoke the LangGraph graph with FULL message history
		// This is critical for maintaining conversation context across tool calls
		const result = await promptEnhancerGraph.invoke(
			{
				messages,
				promptId,
				promptName,
				promptDescription,
				currentContent,
				enhancementType,
				userInstructions,
				format,
				category,
				tags,
				enhancedContent: "",
				explanation: "",
				streamingContent: "",
			},
			{ recursionLimit: DEFAULT_RECURSION_LIMIT },
		);

		console.log("[UnifiedServer] Graph result:", {
			hasEnhancedContent: !!result.enhancedContent,
			contentLength: result.enhancedContent?.length || 0,
			hasExplanation: !!result.explanation,
		});

		// Convert BaseMessage[] to simple message format for the unified server
		const outputMessages = (result.messages || []).map((msg) => ({
			role:
				typeof msg === "object" && "role" in msg
					? String(msg.role)
					: "assistant",
			content:
				typeof msg === "object" && "content" in msg
					? String(msg.content)
					: String(msg),
		}));

		return {
			enhancedContent: result.enhancedContent || "",
			streamingContent: result.enhancedContent || "",
			explanation: result.explanation || "",
			messages: outputMessages,
		};
	},
	// Transform output for A2A response
	(output: Record<string, unknown>) => {
		const enhancedContent = (output.enhancedContent as string) || "";
		const explanation = (output.explanation as string) || "";

		const response = enhancedContent
			? `## Enhanced Prompt\n\n${enhancedContent}\n\n---\n\n## Explanation\n\n${explanation}`
			: explanation || "No enhancement generated";

		return {
			response,
			artifacts: enhancedContent
				? [
						{
							id: uuidv4(),
							name: "enhanced-prompt",
							description: "Enhanced prompt content",
							mimeType: "text/plain",
							parts: [{ type: "text", text: enhancedContent }],
						},
					]
				: [],
			metadata: {
				explanation,
			},
		};
	},
	// A2A streaming executor (not used for now)
	undefined,
	// Platform streaming executor for CopilotKit LangGraphAgent
	// Uses streamMode: ["updates", "messages"] to get both node updates AND LLM token streaming
	async function* (
		input: Record<string, unknown>,
		config?: AgentRuntimeConfig,
	): AsyncGenerator<LangGraphStreamEvent> {
		const rawMessages = input.messages as Array<Record<string, unknown>>;
		// Normalize messages from CopilotKit format to LangChain format
		const messages = normalizeMessages(rawMessages);

		// Extract CopilotKit state from body.state
		// CopilotKit sends agent state in body.state, which gets spread into input
		const copilotState = input.state as Record<string, unknown> | undefined;

		// Get currentContent with proper priority:
		// 1. Direct input.currentContent (A2A or direct API)
		// 2. CopilotKit state (body.state.currentContent)
		// 3. NEVER fall back to last message - that's the user's instruction, not the prompt content!
		const currentContent =
			(input.currentContent as string) ||
			(copilotState?.currentContent as string) ||
			"";

		const promptId =
			(input.promptId as string) ||
			(copilotState?.promptId as string) ||
			uuidv4();
		const promptName =
			(input.promptName as string) ||
			(copilotState?.promptName as string) ||
			"Untitled Prompt";
		const promptDescription =
			(input.promptDescription as string | undefined) ||
			(copilotState?.promptDescription as string | undefined);
		const enhancementType = ((input.enhancementType as string) ||
			(copilotState?.enhancementType as string) ||
			"general") as EnhancementType;
		const userInstructions =
			(input.userInstructions as string | undefined) ||
			(copilotState?.userInstructions as string | undefined);
		const format = ((input.format as string) ||
			(copilotState?.format as string) ||
			"PLAIN_TEXT") as PromptFormat;
		const category =
			(input.category as PromptCategory | undefined) ||
			(copilotState?.category as PromptCategory | undefined);
		const tags =
			(input.tags as string[]) || (copilotState?.tags as string[]) || [];

		console.log("[UnifiedServer] Streaming prompt_enhancer with:", {
			messageCount: messages.length,
			contentLength: currentContent.length,
			contentPreview: currentContent.substring(0, 100),
			enhancementType,
			hasUserInstructions: !!userInstructions,
			hasConfig: !!config,
			hasConfigurable: !!config?.configurable,
			configurableKeys: config?.configurable
				? Object.keys(config.configurable)
				: [],
			hasAiConfig: !!config?.configurable?.ai_api_key,
			aiModel: config?.configurable?.ai_model,
			aiProvider: config?.configurable?.ai_provider,
			aiGatewayUrl: config?.configurable?.ai_gateway_url,
			// Log CopilotKit state for debugging
			hasCopilotState: !!copilotState,
			copilotStateKeys: copilotState ? Object.keys(copilotState) : [],
			copilotStateCurrentContentLength:
				(copilotState?.currentContent as string)?.length || 0,
			copilotStateCurrentContentPreview:
				(copilotState?.currentContent as string)?.substring(0, 100) ||
				"",
			// Log normalized message types to debug conversation flow - use _getType() for LangChain message types
			normalizedMessages: messages.map((m) => ({
				messageType: m._getType(),
				hasToolCalls:
					"tool_calls" in m && !!(m as AIMessage).tool_calls?.length,
				hasToolCallId: "tool_call_id" in m,
				contentPreview:
					typeof m.content === "string"
						? m.content.substring(0, 50)
						: String(m.content).substring(0, 50),
			})),
		});

		// Stream from the LangGraph graph with both updates and messages
		// IMPORTANT: Pass FULL message history to maintain conversation context
		// This is critical for the agent to know if it's after a confirmation
		const stream = await promptEnhancerGraph.stream(
			{
				messages,
				promptId,
				promptName,
				promptDescription,
				currentContent,
				enhancementType,
				userInstructions,
				format,
				category,
				tags,
				enhancedContent: "",
				explanation: "",
				streamingContent: "",
			},
			{
				// Use both "updates" and "messages" to get node updates AND LLM token streaming
				streamMode: ["updates", "messages"] as const,
				// Pass AI provider configuration from CopilotKit
				configurable: config?.configurable,
				recursionLimit: DEFAULT_RECURSION_LIMIT,
			},
		);

		// Track state for streaming content
		let lastNodeName = "enhance_node";
		let finalContent = "";

		// Accumulates streamed enhance_prompt_local tool-call args for
		// predictive state updates, resetting on every new tool call so a
		// retried generation within this stream doesn't leak the previous
		// attempt's partial content (see PredictiveToolArgsAccumulator).
		const predictiveArgs = new PredictiveToolArgsAccumulator({
			toolName: "enhance_prompt_local",
			argKey: "enhancedContent",
		});
		let streamUpdateCount = 0;

		// Iterate over stream and yield events
		for await (const chunk of stream) {
			// With streamMode: ["updates", "messages"], chunks can be:
			// 1. Node updates: [streamMode, { nodeName: stateUpdate }]
			// 2. Message chunks: [streamMode, messageChunk]
			const [streamMode, data] = chunk as [string, unknown];

			if (streamMode === "updates") {
				// Node update - chunk is in format { nodeName: stateUpdate }
				for (const [nodeName, stateUpdate] of Object.entries(
					data as Record<string, unknown>,
				)) {
					const state = stateUpdate as Record<string, unknown>;
					lastNodeName = nodeName;

					console.log(
						`[Prompt Enhancer] Stream update from node: ${nodeName}`,
						{
							hasEnhancedContent: !!state.enhancedContent,
							hasStreamingContent: !!state.streamingContent,
							contentLength:
								(state.enhancedContent as string)?.length ||
								(state.streamingContent as string)?.length ||
								0,
						},
					);

					// Update final content if we have one
					if (state.enhancedContent) {
						finalContent = state.enhancedContent as string;
					}

					// Yield the update event with proper state
					yield {
						nodeName,
						state: {
							...state,
							// Ensure streamingContent is set for the UI
							streamingContent:
								state.streamingContent ||
								state.enhancedContent ||
								finalContent ||
								"",
						},
					};
				}
			} else if (streamMode === "messages") {
				// Message chunk - extract tool call arguments for predictive state updates
				// This enables real-time streaming of content as it's being generated
				const messageChunk = data as [unknown, unknown];
				const [message] = messageChunk;

				// Debug: Log what we receive (first few chunks only)
				if (streamUpdateCount < 5) {
					console.log(
						`[Prompt Enhancer] Messages chunk #${streamUpdateCount}:`,
						{
							hasMessage: !!message,
							messageType: typeof message,
							hasToolCallChunks: !!(message as any)
								?.tool_call_chunks,
							toolCallChunksCount:
								(message as any)?.tool_call_chunks?.length || 0,
						},
					);
				}
				streamUpdateCount++;

				// Check if this is a tool call chunk with content
				const msgAny = message as any;
				if (
					msgAny?.tool_call_chunks &&
					msgAny.tool_call_chunks.length > 0
				) {
					for (const toolChunk of msgAny.tool_call_chunks) {
						const partialContent = predictiveArgs.push(
							toolChunk,
							Date.now(),
						);
						if (partialContent !== null) {
							// Emit intermediate streaming update for predictive state
							console.log(
								"[Prompt Enhancer] Predictive state update:",
								{
									partialContentLength: partialContent.length,
									preview: `${partialContent.substring(0, 50)}...`,
								},
							);

							yield {
								nodeName: lastNodeName,
								state: {
									streamingContent: partialContent,
									enhancedContent: partialContent, // Also update enhancedContent for UI consistency
								},
								// Preview-only: each partial supersedes the last, and the
								// authoritative content arrives via the node "updates"
								// event — safe for the server to coalesce under backpressure.
								droppable: true,
							};
						}
					}
				}
			}
		}
	},
);

// Start the server
start();

export { app };
