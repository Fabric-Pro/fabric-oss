/**
 * Enhance Node
 *
 * Main node for enhancing prompts with AI assistance following the ag-ui-demo pattern.
 *
 * Key behaviors:
 * - Always streams enhanced content via predictive state updates
 * - Model generates summary alongside tool call (in response.content)
 * - After enhance_prompt_local, adds confirm_changes tool call and ends
 * - Detects post-confirmation state and outputs acknowledgment only (no tool calls)
 * - Frontend handles confirm/reject locally (no second agent call needed)
 */

import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	SystemMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, END } from "@langchain/langgraph";
import {
	detectAndCompose,
	logAgentUsageFromRunnableConfig,
} from "@repo/agent-core";
import { shapeHistoryForModel } from "@repo/agent-core/message-shape";
import {
	buildReasoningUpdate,
	countHumanMessages,
	stripRawResponseEnvelope,
} from "@repo/agent-core/reasoning-trace";
import { ENHANCE_PROMPT_TOOL } from "@repo/agent-tools";
import { v4 as uuidv4 } from "uuid";
import { getPredictStateConfig, getSystemPrompt } from "../prompts";
import type { PromptEnhancerStateType } from "../state";
import {
	calculateRetryDelay,
	extractProviderConfig,
	getAgentModelAsync,
	isJsonParseError,
	MAX_JSON_RETRIES,
	MAX_RETRIES,
	sleep,
} from "../utils";

/**
 * Get message type - handles multiple formats:
 * - LangChain classes: _getType() returns 'human', 'ai', 'tool', etc.
 * - AG-UI format: 'type' property with 'human', 'ai', 'tool'
 * - OpenAI format: 'role' property with 'user', 'assistant', 'tool'
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
 * Check if we should handle post-confirmation (user just clicked Accept/Reject).
 * SIMPLE RULE: Post-confirmation is ONLY when the LAST message is a tool response
 * to confirm_changes. Any other last message means process normally.
 */
function isAfterConfirmation(messages: BaseMessage[]): {
	isAfter: boolean;
	accepted: boolean;
} {
	if (!messages || messages.length < 2) {
		return { isAfter: false, accepted: false };
	}

	const lastMsg = messages[messages.length - 1];
	const secondLastMsg = messages[messages.length - 2];

	// Check if last message is a tool response
	if (getMessageType(lastMsg) !== "tool") {
		return { isAfter: false, accepted: false };
	}

	// Check if the tool response contains "accepted"
	const content = typeof lastMsg.content === "string" ? lastMsg.content : "";
	if (!content.includes("accepted")) {
		return { isAfter: false, accepted: false };
	}

	// Check if second-to-last is an AI message with confirm_changes tool call
	if (getMessageType(secondLastMsg) !== "ai") {
		return { isAfter: false, accepted: false };
	}

	const toolCalls =
		(secondLastMsg as any).tool_calls || (secondLastMsg as any).toolCalls;
	if (
		!toolCalls?.some(
			(tc: any) => (tc.name || tc.function?.name) === "confirm_changes",
		)
	) {
		return { isAfter: false, accepted: false };
	}

	const accepted =
		content.includes('"accepted":true') ||
		content.includes('"accepted": true');
	console.log("[Prompt Enhancer] Post-confirmation state detected", {
		accepted,
	});
	return { isAfter: true, accepted };
}

/**
 * Sanitize messages for the model API call.
 *
 * CopilotKit often sends back malformed message history:
 * - AI messages split into content-only and tool_calls-only messages
 * - Missing tool responses (e.g., enhance_prompt_local response dropped)
 * - Tool calls stripped from some AI messages
 *
 * When these malformed messages go through ChatOpenAI → Vercel Gateway → Anthropic,
 * the format conversion fails with: "toolUse.input is invalid"
 *
 * Fix: Strip tool_calls and tool messages from conversation history.
 * The model gets the current content via the system prompt, so it doesn't
 * need to see the exact tool call history.
 */
function sanitizeMessagesForModel(messages: BaseMessage[]): BaseMessage[] {
	const result: BaseMessage[] = [];

	for (const msg of messages) {
		const msgType = getMessageType(msg);

		// Remove system messages (we prepend our own)
		if (msgType === "system" || msg instanceof SystemMessage) {
			continue;
		}

		// Remove tool messages - they reference tool_calls that may be
		// missing or malformed after CopilotKit processing
		if (msgType === "tool") {
			continue;
		}

		// For AI messages, strip tool_calls to avoid serialization issues
		// with Vercel Gateway's OpenAI→Anthropic format conversion
		if (msgType === "ai") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: String(msg.content || "");

			// Skip empty AI messages (from CopilotKit splits)
			if (content.trim().length === 0) {
				continue;
			}

			// Merge with previous AI message if consecutive
			// (Anthropic requires strictly alternating user/assistant messages)
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

		// Merge consecutive human messages
		// (Anthropic requires strictly alternating user/assistant messages)
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
		console.warn("[Prompt Enhancer] Dropped trailing assistant turn(s)", {
			dropped: droppedTurns,
		});
	}

	console.log("[Prompt Enhancer] Sanitized messages for model", {
		inputCount: messages.length,
		outputCount: shaped.length,
		outputTypes: shaped.map((m) => getMessageType(m)),
	});

	return shaped;
}

/**
 * Enhance node for prompt improvement following ag-ui-demo pattern
 *
 * Flow:
 * 1. Build system prompt with current content
 * 2. Invoke model with enhance_prompt_local tool
 * 3. Model streams enhanced content via predictive state AND generates summary in content
 * 4. Add tool response and confirm_changes tool call
 * 5. Return to END - frontend handles confirmation locally
 *
 * @param state - Current agent state
 * @param config - Runnable configuration
 * @returns Command to update state and route to END
 */
export async function enhanceNode(
	state: PromptEnhancerStateType,
	config: RunnableConfig,
): Promise<Command> {
	try {
		const generationStart = Date.now();
		console.log("[Prompt Enhancer] Starting enhance node", {
			promptId: state.promptId,
			promptName: state.promptName,
			currentContentLength: state.currentContent?.length || 0,
			messageCount: state.messages?.length || 0,
			retryCount: state.retryCount || 0,
		});

		// =====================================================================
		// POST-CONFIRMATION HANDLING
		// =====================================================================
		// After user clicks Accept/Reject, CopilotKit sends a tool response back.
		// We detect this and return a simple acknowledgment WITHOUT calling tools.
		// This prevents the infinite confirm_changes loop.
		const confirmationStatus = isAfterConfirmation(state.messages);
		if (confirmationStatus.isAfter) {
			console.log("[Prompt Enhancer] Handling post-confirmation", {
				accepted: confirmationStatus.accepted,
			});

			// Create a simple acknowledgment message (no tool calls!)
			const acknowledgment = confirmationStatus.accepted
				? "Changes have been applied to your prompt."
				: "Changes have been discarded. Your prompt remains unchanged.";

			const ackMessage = new AIMessage({ content: acknowledgment });

			return new Command({
				goto: END,
				update: {
					messages: [...state.messages, ackMessage],
					error: undefined,
				},
			});
		}

		// Extract provider config from runtime config using shared utility
		const providerConfig = extractProviderConfig(config);

		// Create model with provider config from CopilotKit runtime or API fallback
		// Use lower temperature on retries to reduce JSON parse errors
		const temperature = Math.max(0.1, 0.3 - (state.retryCount || 0) * 0.1);
		// No explicit maxTokens: the factory sizes the budget against the
		// resolved model's catalog cap rather than a literal.
		const model = await getAgentModelAsync(config, {
			temperature,
			taskType: "TOOL_CALLING",
		});

		console.log(
			"[Prompt Enhancer] Using model:",
			providerConfig?.model || "(API fallback)",
			{ temperature },
		);

		// Build system prompt for requests
		let systemPrompt = getSystemPrompt(state.currentContent, state.format);

		console.log("[Prompt Enhancer] System prompt built", {
			promptLength: systemPrompt.length,
			hasCurrentContent: (state.currentContent?.length || 0) > 0,
		});

		// Apply Fabric AI prompt enhancement
		// Extract user message from the latest human message
		const userMessage =
			state.messages
				.filter((m: any) => getMessageType(m) === "human")
				.map((m: any) =>
					typeof m.content === "string" ? m.content : "",
				)
				.pop() || "";

		if (userMessage) {
			try {
				const fabricResult = await detectAndCompose({
					userMessage,
					basePrompt: systemPrompt,
				});

				if (
					fabricResult.fabricAvailable &&
					(fabricResult.components.pattern ||
						fabricResult.components.context ||
						fabricResult.components.strategy)
				) {
					systemPrompt = fabricResult.prompt;
					console.log(
						"[Prompt Enhancer] Fabric AI enhancement applied:",
						{
							pattern: fabricResult.components.pattern,
							context: fabricResult.components.context,
							strategy: fabricResult.components.strategy,
						},
					);
				}
			} catch (error) {
				console.warn(
					"[Prompt Enhancer] Fabric AI enhancement failed, using base prompt:",
					error,
				);
			}
		}

		// Configure predictive state updates
		const runnableConfig = config ?? {};

		if (!runnableConfig.metadata) {
			runnableConfig.metadata = {};
		}

		// Always enable predictive state streaming (ag-ui-demo pattern)
		runnableConfig.metadata.predict_state = getPredictStateConfig();

		// Bind tools to the model
		if (!model.bindTools) {
			throw new Error(
				"[Prompt Enhancer] Model does not support tool binding",
			);
		}

		// Only bind enhance_prompt_local - like ag-ui-demo
		const modelWithTools = model.bindTools([ENHANCE_PROMPT_TOOL], {
			parallel_tool_calls: false,
		} as Record<string, unknown>);

		console.log("[Prompt Enhancer] Bound tools:", { toolCount: 1 });

		// Sanitize messages: strip tool_calls, tool messages, merge consecutive AI
		// messages to prevent Anthropic 400 errors from malformed CopilotKit history
		const filteredMessages = sanitizeMessagesForModel(state.messages);
		const messages = [new SystemMessage(systemPrompt), ...filteredMessages];

		// Invoke the model. turnStart is captured BEFORE invoke per
		// buildReasoningUpdate protocol P3 (otherwise durationMs ≈ 0).
		const turnStart = Date.now();
		const response = await modelWithTools.invoke(messages, runnableConfig);
		await logAgentUsageFromRunnableConfig(runnableConfig, response, {
			taskType: "TOOL_CALLING",
			agentId: "prompt_enhancer",
			latencyMs: Date.now() - generationStart,
		});

		// === Reasoning capture (shared lib, F-1171 follow-up) ===
		// buildReasoningUpdate MUST run BEFORE stripRawResponseEnvelope —
		// see protocol P1 in @repo/agent-core/reasoning-trace/emit.ts.
		const reasoningByTurnUpdate = buildReasoningUpdate({
			response,
			existingByTurn: state.reasoningByTurn,
			stateMessages: state.messages,
			turnStart,
			loggerLabel: "[Prompt Enhancer]",
		});
		stripRawResponseEnvelope(response);

		if (reasoningByTurnUpdate.reasoningByTurn) {
			const turnIndex = countHumanMessages(state.messages);
			const entry = reasoningByTurnUpdate.reasoningByTurn[turnIndex];
			console.log("[Prompt Enhancer] Reasoning emitted", {
				turnIndex,
				textLength: entry?.text.length ?? 0,
				durationMs: entry?.durationMs ?? 0,
			});
		}

		// Update messages with response (includes any summary in response.content)
		const updatedMessages = [...state.messages, response];

		// Handle tool calls
		if (response.tool_calls && response.tool_calls.length > 0) {
			const toolCall = response.tool_calls[0];
			if (toolCall.name === "enhance_prompt_local") {
				const args = toolCall.args as {
					enhancedContent: string;
					focusAnchor?: string;
				};

				console.log("[Prompt Enhancer] Prompt enhanced", {
					contentLength: args.enhancedContent.length,
					hasFocusAnchor: !!args.focusAnchor,
				});

				// Add tool response
				const toolResponse = {
					role: "tool" as const,
					content: "Prompt enhanced successfully.",
					tool_call_id: toolCall.id,
				};

				// Generate a follow-up message for prompt enhancement
				// Models often return empty content with tool calls, so we generate our own
				const followUpOptions = [
					"Would you like me to add more specific examples or edge cases?",
					"Should I make the instructions more detailed?",
					"Would you like me to add output format specifications?",
					"Should I include constraints or guardrails?",
				];
				const randomFollowUp =
					followUpOptions[
						Math.floor(Math.random() * followUpOptions.length)
					];
				const followUpMessage = `I've enhanced your prompt. ${randomFollowUp}`;

				// Add confirmation tool call (ag-ui-demo pattern)
				// Include generated follow-up question so it appears in sidebar
				const confirmToolCall = {
					role: "assistant" as const,
					content: followUpMessage,
					tool_calls: [
						{
							id: uuidv4(),
							type: "function" as const,
							function: {
								name: "confirm_changes",
								arguments: {},
							},
						},
					],
				};

				// Return to END - frontend handles confirmation locally
				return new Command({
					update: {
						enhancedContent: args.enhancedContent,
						streamingContent: args.enhancedContent,
						focusAnchor: args.focusAnchor,
						messages: [
							...updatedMessages,
							toolResponse,
							confirmToolCall,
						],
						retryCount: 0,
						error: undefined,
						...reasoningByTurnUpdate,
					},
					goto: END,
				});
			}
		}

		// Fallback: no tool call
		console.log(
			"[Prompt Enhancer] No tool call - likely a follow-up message",
		);

		return new Command({
			update: {
				messages: updatedMessages,
				error: undefined,
				...reasoningByTurnUpdate,
			},
			goto: END,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		const isJsonError = error instanceof Error && isJsonParseError(error);

		console.error("[Prompt Enhancer] Error in enhance node", {
			error: errorMessage,
			isJsonParseError: isJsonError,
			retryCount: state.retryCount || 0,
		});

		// Determine max retries based on error type
		const maxRetries = isJsonError ? MAX_JSON_RETRIES : MAX_RETRIES;
		const currentRetryCount = state.retryCount || 0;

		if (currentRetryCount < maxRetries) {
			const nextRetryCount = currentRetryCount + 1;
			const delayMs = calculateRetryDelay(currentRetryCount);

			console.log("[Prompt Enhancer] Retrying with backoff...", {
				retryCount: nextRetryCount,
				maxRetries,
				delayMs,
				isJsonParseError: isJsonError,
			});

			await sleep(delayMs);

			return new Command({
				goto: "enhance" as typeof END,
				update: {
					retryCount: nextRetryCount,
					error: `Retrying... (attempt ${nextRetryCount}/${maxRetries})`,
				},
			});
		}

		// Max retries reached
		console.error("[Prompt Enhancer] Max retries reached", {
			retryCount: currentRetryCount,
			maxRetries,
			isJsonParseError: isJsonError,
		});

		// Create user-friendly error message
		let userFacingError: string;
		if (isJsonError) {
			userFacingError =
				"The AI had difficulty processing this prompt. This can happen with complex template syntax. Please try again or simplify the request.";
		} else {
			userFacingError = `Failed to enhance prompt: ${errorMessage}`;
		}

		// Add error message to conversation
		const errorResponse = {
			role: "assistant" as const,
			content: userFacingError,
		};

		return new Command({
			goto: END,
			update: {
				messages: [...state.messages, errorResponse],
				error: userFacingError,
				retryCount: 0,
			},
		});
	}
}
