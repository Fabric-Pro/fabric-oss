import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { buildAgentConfigurable } from "@repo/agent-core/services/agent-configurable";
import type { LangGraphExecutor } from "@repo/agent-core/unified-server";
import type { DocumentType, ProjectContext } from "@repo/agent-types";
import type { predictiveStateUpdatesGraph as agentGraph } from "./agent.js";
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
			const toolName = (msg.name as string) || "confirm_changes"; // Default for confirmation tools

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

				// Helper to parse tool call args - Anthropic requires args to be an object
				// CopilotKit may send args as a JSON string, so we need to parse it
				const parseToolCallArgs = (
					tc: Record<string, unknown>,
				): Record<string, unknown> => {
					// Try tc.args first
					let args = tc.args;
					// Fallback to tc.function.arguments (OpenAI format)
					if (!args && tc.function) {
						args = (tc.function as Record<string, unknown>)
							?.arguments;
					}
					// If args is a string, try to parse it as JSON
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
					// If args is already an object, return it
					if (args && typeof args === "object") {
						return args as Record<string, unknown>;
					}
					return {};
				};

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
	predictiveStateUpdatesGraph: Pick<typeof agentGraph, "invoke">,
): LangGraphExecutor {
	return async (input, runtimeConfig) => {
		const rawMessages = input.messages as Array<Record<string, unknown>>;
		// Normalize messages from CopilotKit format to LangChain format
		const messages = normalizeMessages(rawMessages);
		const documentType = ((input.documentType as string) ||
			"general") as DocumentType;
		// CRITICAL: Extract document from CopilotKit state
		// CopilotKit sends agent state in body.state, which gets spread into input
		const copilotKitState = input.state as
			| Record<string, unknown>
			| undefined;
		const document =
			(copilotKitState?.document as string) ||
			(input.document as string) ||
			"";

		// Extract project context and RAG contexts if available
		const projectContext = (input.projectContext ||
			copilotKitState?.projectContext) as ProjectContext | undefined;
		const ragContexts = (input.ragContexts ||
			copilotKitState?.ragContexts ||
			[]) as string[];

		console.log("[UnifiedServer] Invoking document_generator with:", {
			messageCount: messages.length,
			documentType,
			hasDocument: !!document,
			documentLength: document.length,
			hasProjectContext: !!projectContext,
			hasRagContexts: ragContexts.length > 0,
			ragContextCount: ragContexts.length,
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

		// Invoke the LangGraph graph with FULL message history AND document state
		// This is critical for maintaining conversation context across tool calls
		// Include project context and RAG contexts if available for improved document quality
		const result = await predictiveStateUpdatesGraph.invoke(
			{
				messages,
				documentType,
				document, // Pass the current document for content preservation
				projectContext, // Optional project context for context-aware generation
				ragContexts, // Optional RAG contexts for improved accuracy
				tools: [],
			},
			{
				recursionLimit: DEFAULT_RECURSION_LIMIT,
				signal: runtimeConfig?.signal,
				configurable: buildAgentConfigurable(
					input,
					runtimeConfig?.configurable,
				),
			},
		);

		console.log("[UnifiedServer] Graph result:", {
			hasDocument: !!result.document,
			documentLength: result.document?.length || 0,
		});

		return {
			document: result.document || "",
			streamingContent: result.document || "",
			error: result.error,
		};
	};
}
