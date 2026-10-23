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

import type { AIMessage } from "@langchain/core/messages";
import {
	type AgentRuntimeConfig,
	type AgentSkill,
	createUnifiedServer,
	getUserFacingError,
	type LangGraphStreamEvent,
	PredictiveToolArgsAccumulator,
} from "@repo/agent-core";
import { v4 as uuidv4 } from "uuid";
import { promptEnhancerGraph } from "./agent.js";
import { createInvokeAgent, normalizeMessages } from "./invoke-agent.js";
import type { EnhancementType, PromptCategory, PromptFormat } from "./types.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils";

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
	createInvokeAgent(promptEnhancerGraph),
	// Transform output for A2A response
	(output: Record<string, unknown>) => {
		const enhancedContent = (output.enhancedContent as string) || "";
		const explanation = (output.explanation as string) || "";

		const response = enhancedContent
			? `## Enhanced Prompt\n\n${enhancedContent}\n\n---\n\n## Explanation\n\n${explanation}`
			: explanation || "No enhancement generated";

		return {
			error: getUserFacingError(output.error, output.failureText),
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
				signal: config?.signal,
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
