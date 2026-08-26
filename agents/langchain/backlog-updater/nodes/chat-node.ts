/**
 * Chat Node
 *
 * Main conversational node for the Backlog Updater agent.
 *
 * Key behaviors:
 * - All interactive tools are CopilotKit frontend actions (useCopilotAction)
 * - No server-side tools — CopilotKit tools are bound from state.tools
 * - System prompt dynamically adapts based on available integrations
 * - After apply_backlog_changes tool response, outputs summary without further tool calls
 * - Message sanitization prevents Anthropic 400 errors from malformed CopilotKit history
 */

import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	SystemMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, END } from "@langchain/langgraph";
import { logAgentUsageFromRunnableConfig } from "@repo/agent-core";
import { shapeHistoryForModel } from "@repo/agent-core/message-shape";
import {
	buildReasoningUpdate,
	countHumanMessages,
	stripRawResponseEnvelope,
} from "@repo/agent-core/reasoning-trace";
import { logger } from "@repo/logs";
import { buildBacklogUpdaterPrompt, getPredictStateConfig } from "../prompts";
import type { BacklogUpdaterState } from "../state";
import {
	calculateRetryDelay,
	getAgentModelAsync,
	isRetryableError,
	MAX_RETRIES,
	sleep,
} from "../utils";

/**
 * Get message type - handles multiple formats from CopilotKit and LangChain
 */
function getMessageType(msg: any): string {
	if (msg._getType) {
		return msg._getType();
	}
	if (msg.type && typeof msg.type === "string") {
		if (msg.type === "human") {
			return "human";
		}
		if (msg.type === "ai") {
			return "ai";
		}
		if (msg.type === "tool") {
			return "tool";
		}
		return msg.type;
	}
	if (msg.role) {
		if (msg.role === "user") {
			return "human";
		}
		if (msg.role === "assistant") {
			return "ai";
		}
		if (msg.role === "tool") {
			return "tool";
		}
		return msg.role;
	}
	return "unknown";
}

/**
 * Check if the last message is a tool response from a terminal step
 * (review_backlog_changes or apply_backlog_changes).
 * If so, we return a summary message without further tool calls to prevent loops.
 *
 * review_backlog_changes is terminal because the UI handles apply directly
 * (bypassing the LLM) once the user approves/rejects.
 */
const TERMINAL_TOOLS = new Set([
	"review_backlog_changes",
	"apply_backlog_changes",
]);

function isAfterTerminalTool(messages: BaseMessage[]): boolean {
	if (!messages || messages.length < 2) {
		return false;
	}

	const lastMsg = messages[messages.length - 1];
	const secondLastMsg = messages[messages.length - 2];

	if (getMessageType(lastMsg) !== "tool") {
		return false;
	}

	if (getMessageType(secondLastMsg) !== "ai") {
		return false;
	}

	const toolCalls =
		(secondLastMsg as any).tool_calls || (secondLastMsg as any).toolCalls;
	if (!toolCalls || toolCalls.length === 0) {
		return false;
	}

	return toolCalls.some((tc: any) => {
		const name = tc.name || tc.function?.name;
		return TERMINAL_TOOLS.has(name);
	});
}

/**
 * Sanitize messages for the model API call.
 *
 * CopilotKit often sends back malformed message history:
 * - AI messages split into content-only and tool_calls-only messages
 * - Missing tool responses
 * - Tool calls stripped from some AI messages
 *
 * Fix: Strip tool_calls and tool messages from conversation history.
 * The model gets context via the system prompt, so it doesn't need
 * to see the exact tool call history.
 */
function sanitizeMessagesForModel(messages: BaseMessage[]): BaseMessage[] {
	const result: BaseMessage[] = [];

	for (const msg of messages) {
		const msgType = getMessageType(msg);

		// Remove system messages (we prepend our own)
		if (msgType === "system" || msg instanceof SystemMessage) {
			continue;
		}

		// Convert tool result messages to human messages so the model
		// knows what the user selected/confirmed (e.g. selected meetings).
		// Include the tool name so the model can determine the next step.
		if (msgType === "tool") {
			const toolName = (msg as any).name || "unknown_tool";
			const content =
				typeof msg.content === "string"
					? msg.content
					: JSON.stringify(msg.content || "");
			if (content.trim().length > 0) {
				const toolResultMsg = new HumanMessage({
					content: `[Result from ${toolName}]: ${content}`,
				});
				// Merge with previous human message if consecutive
				const lastResult =
					result.length > 0 ? result[result.length - 1] : null;
				if (lastResult && getMessageType(lastResult) === "human") {
					const lastContent =
						typeof lastResult.content === "string"
							? lastResult.content
							: "";
					result[result.length - 1] = new HumanMessage({
						content: `${lastContent}\n\n${typeof toolResultMsg.content === "string" ? toolResultMsg.content : ""}`,
					});
				} else {
					result.push(toolResultMsg);
				}
			}
			continue;
		}

		// For AI messages, strip tool_calls to avoid serialization issues
		if (msgType === "ai") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: String(msg.content || "");

			// Skip empty AI messages (from CopilotKit splits)
			if (content.trim().length === 0) {
				continue;
			}

			// Merge with previous AI message if consecutive (Anthropic alternation requirement)
			const lastResult =
				result.length > 0 ? result[result.length - 1] : null;
			if (lastResult && getMessageType(lastResult) === "ai") {
				const lastContent =
					typeof lastResult.content === "string"
						? lastResult.content
						: "";
				result[result.length - 1] = new AIMessage({
					content: `${lastContent}\n\n${content}`,
				});
			} else {
				result.push(new AIMessage({ content }));
			}
			continue;
		}

		// Merge consecutive human messages (Anthropic alternation requirement)
		const humanContent =
			typeof msg.content === "string"
				? msg.content
				: String(msg.content || "");
		const lastHumanResult =
			result.length > 0 ? result[result.length - 1] : null;
		if (lastHumanResult && getMessageType(lastHumanResult) === "human") {
			const lastContent =
				typeof lastHumanResult.content === "string"
					? lastHumanResult.content
					: "";
			result[result.length - 1] = new HumanMessage({
				content: `${lastContent}\n\n${humanContent}`,
			});
		} else {
			result.push(msg);
		}
	}

	// Claude refuses a history that ends on an assistant turn ("does not support
	// assistant message prefill"). The passes above can leave one behind when
	// they strip the tool results that followed it.
	const { messages: shaped, dropped: droppedTurns } =
		shapeHistoryForModel(result);
	if (droppedTurns > 0) {
		logger.warn("[Backlog Updater] Dropped trailing assistant turn(s)", {
			dropped: droppedTurns,
		});
	}

	logger.info("[Backlog Updater] Sanitized messages for model", {
		inputCount: messages.length,
		outputCount: shaped.length,
		outputTypes: shaped.map((m) => getMessageType(m)),
	});

	return shaped;
}

/**
 * Chat node for the Backlog Updater agent.
 *
 * Flow:
 * 1. Build dynamic system prompt with integration state
 * 2. Bind CopilotKit tools from state.tools
 * 3. Invoke model with messages
 * 4. Return updated state
 *
 * All interactive tools (select_review_sources, analyze_backlog, review_backlog_changes,
 * apply_backlog_changes) are CopilotKit frontend actions registered via useCopilotAction.
 */
export async function chatNode(
	state: BacklogUpdaterState,
	config?: RunnableConfig,
): Promise<Command> {
	try {
		const generationStart = Date.now();
		if (!state.messages || state.messages.length === 0) {
			throw new Error("No messages in state");
		}

		logger.info("[Backlog Updater] chatNode invoked", {
			messageCount: state.messages.length,
			projectId: state.projectId,
			projectName: state.projectName,
			hasTeams: state.hasTeamsIntegration,
			hasNotion: state.hasNotionIntegration,
			hasPM: state.hasPMTool,
		});

		// =====================================================================
		// POST-APPLY HANDLING
		// =====================================================================
		// After apply_backlog_changes completes, return a summary message
		// without further tool calls to prevent loops.
		if (isAfterTerminalTool(state.messages)) {
			logger.info(
				"[Backlog Updater] Handling post-apply, returning summary",
			);

			const ackMessage = new AIMessage({
				content: "Done! The results are shown in the card above.",
			});

			return new Command({
				goto: END,
				update: {
					messages: [...state.messages, ackMessage],
					error: undefined,
				},
			});
		}

		// Check retry limit
		if (state.retryCount >= MAX_RETRIES) {
			logger.error("[Backlog Updater] Max retries exceeded", {
				retryCount: state.retryCount,
			});
			return new Command({
				goto: END,
				update: {
					error: "Maximum retry attempts exceeded. Please try again.",
					messages: state.messages,
				},
			});
		}

		// Build dynamic system prompt
		const systemPrompt = buildBacklogUpdaterPrompt(state);

		logger.info("[Backlog Updater] Built system prompt", {
			promptLength: systemPrompt.length,
		});

		// Create model using provider config
		// No explicit maxTokens: the factory sizes the budget against the
		// resolved model's catalog cap. The literal 4,000 that used to sit here
		// truncated backlog analyses on models rated far higher.
		const model = await getAgentModelAsync(config, {
			temperature: 0.4,
			retryCount: state.retryCount,
			taskType: "TOOL_CALLING",
		});

		// Configure runnable with predict_state for streaming
		const runnableConfig = config ?? {};

		if (!runnableConfig.metadata) {
			runnableConfig.metadata = {};
		}

		runnableConfig.metadata.predict_state = getPredictStateConfig();

		// Bind CopilotKit frontend action tools from state
		// These are the tools registered via useCopilotAction in the frontend
		const copilotKitTools = state.tools || [];

		let modelToInvoke: any;
		if (copilotKitTools.length > 0 && model.bindTools) {
			modelToInvoke = model.bindTools(copilotKitTools, {
				parallel_tool_calls: false,
			} as Record<string, unknown>);
			logger.info("[Backlog Updater] Bound CopilotKit tools", {
				toolCount: copilotKitTools.length,
			});
		} else {
			// No tools available — model operates in pure chat mode
			modelToInvoke = model;
			logger.info("[Backlog Updater] No tools to bind, using chat mode");
		}

		// Sanitize messages for Anthropic alternation requirement
		const filteredMessages = sanitizeMessagesForModel(state.messages);

		logger.info("[Backlog Updater] Invoking model", {
			messageCount: filteredMessages.length,
		});

		// Invoke the model. turnStart is captured BEFORE invoke per
		// buildReasoningUpdate protocol P3 (otherwise durationMs ≈ 0).
		const turnStart = Date.now();
		const response = await modelToInvoke.invoke(
			[new SystemMessage({ content: systemPrompt }), ...filteredMessages],
			runnableConfig,
		);
		await logAgentUsageFromRunnableConfig(runnableConfig, response, {
			taskType: "TOOL_CALLING",
			agentId: "backlog_updater",
			latencyMs: Date.now() - generationStart,
			projectId: state.projectId,
		});

		logger.info("[Backlog Updater] Model response received", {
			hasToolCalls:
				!!response.tool_calls && response.tool_calls.length > 0,
			toolCallCount: response.tool_calls?.length || 0,
			hasContent: !!response.content,
		});

		// === Reasoning capture (shared lib, F-1171 follow-up) ===
		// buildReasoningUpdate MUST run BEFORE stripRawResponseEnvelope —
		// see protocol P1 in @repo/agent-core/reasoning-trace/emit.ts.
		const reasoningByTurnUpdate = buildReasoningUpdate({
			response,
			existingByTurn: state.reasoningByTurn,
			stateMessages: state.messages,
			turnStart,
			loggerLabel: "[Backlog Updater]",
		});
		stripRawResponseEnvelope(response);

		if (reasoningByTurnUpdate.reasoningByTurn) {
			const turnIndex = countHumanMessages(state.messages);
			const entry = reasoningByTurnUpdate.reasoningByTurn[turnIndex];
			logger.info("[Backlog Updater] Reasoning emitted", {
				turnIndex,
				textLength: entry?.text.length ?? 0,
				durationMs: entry?.durationMs ?? 0,
			});
		}

		// Return updated state with the model's response
		return new Command({
			goto: END,
			update: {
				messages: [...state.messages, response],
				error: undefined,
				retryCount: 0,
				...reasoningByTurnUpdate,
			},
		});
	} catch (error) {
		logger.error("[Backlog Updater] Error in chatNode", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			retryCount: state.retryCount,
		});

		// Handle retryable errors
		if (error instanceof Error && isRetryableError(error)) {
			if (state.retryCount < MAX_RETRIES) {
				const delay = calculateRetryDelay(state.retryCount);
				logger.info(
					`[Backlog Updater] Retrying in ${delay}ms (attempt ${state.retryCount + 1}/${MAX_RETRIES})`,
				);

				await sleep(delay);

				return new Command({
					goto: "chat_node" as typeof END,
					update: {
						retryCount: state.retryCount + 1,
						error: `Retrying... (attempt ${state.retryCount + 1}/${MAX_RETRIES})`,
					},
				});
			}
		}

		// Non-retryable or max retries exceeded
		const errorMessage =
			error instanceof Error
				? error.message
				: "An unexpected error occurred";

		return new Command({
			goto: END,
			update: {
				messages: state.messages,
				error: `Failed to process request: ${errorMessage}`,
				retryCount: state.retryCount + 1,
			},
		});
	}
}
