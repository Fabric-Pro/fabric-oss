import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { buildAgentConfigurable } from "@repo/agent-core/services/agent-configurable";
import type { LangGraphExecutor } from "@repo/agent-core/unified-server";
import { convertToSimpleMessages } from "@repo/agent-core/utils/message-converter";
import { v4 as uuidv4 } from "uuid";
import type { promptEnhancerGraph as agentGraph } from "./agent.js";
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

export function normalizeMessages(
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

export function createInvokeAgent(
	promptEnhancerGraph: Pick<typeof agentGraph, "invoke">,
): LangGraphExecutor {
	return async (input, runtimeConfig) => {
		const rawMessages = input.messages as Array<Record<string, unknown>>;
		// Normalize messages from CopilotKit format to LangChain format
		const messages = normalizeMessages(rawMessages);

		// Extract CopilotKit state from body.state
		// CopilotKit sends agent state in body.state, which gets spread into input
		const copilotState = input.state as Record<string, unknown> | undefined;

		// Get currentContent with proper priority:
		// 1. Direct input.currentContent (A2A or direct API)
		// 2. CopilotKit state (body.state.currentContent)
		// 3. The last message supplies the instruction rather than the prompt content.
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
			{
				recursionLimit: DEFAULT_RECURSION_LIMIT,
				configurable: buildAgentConfigurable(
					input,
					runtimeConfig?.configurable,
				),
			},
		);

		console.log("[UnifiedServer] Graph result:", {
			hasEnhancedContent: !!result.enhancedContent,
			contentLength: result.enhancedContent?.length || 0,
			hasExplanation: !!result.explanation,
		});

		const lastGraphMessage = result.messages?.at(-1);
		const failureText =
			result.error &&
			AIMessage.isInstance(lastGraphMessage) &&
			typeof lastGraphMessage.content === "string"
				? lastGraphMessage.content
				: undefined;

		// Convert BaseMessage[] to simple message format for the unified server
		const outputMessages = convertToSimpleMessages(result.messages || []);

		return {
			failureText,
			error: result.error,
			enhancedContent: result.enhancedContent || "",
			streamingContent: result.enhancedContent || "",
			explanation: result.explanation || "",
			messages: outputMessages,
		};
	};
}
