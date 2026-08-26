/**
 * Breakdown Node
 *
 * Main node for breaking down PRDs into features.
 * Enhanced with Fabric AI prompt composition for better results.
 *
 * Key behaviors:
 * - Detects post-confirmation state and outputs acknowledgment only (no tool calls)
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
	isOutputTruncated,
	resolveStopReason,
} from "@repo/agent-core/output-truncation";
import {
	buildReasoningUpdate,
	countHumanMessages,
	stripRawResponseEnvelope,
} from "@repo/agent-core/reasoning-trace";
import { WRITE_DOCUMENT_TOOL } from "@repo/agent-tools";
import { v4 as uuidv4 } from "uuid";
import {
	buildUserMessage,
	getDefaultSystemPrompt,
	getPredictStateConfig,
} from "../prompts";
import type { StoryBreakdownStateType } from "../state";
import {
	calculateRetryDelay,
	getAgentModel,
	isJsonParseError,
	isRetryableError,
	MAX_RETRIES,
	type ProviderConfig,
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
	console.log("[Story Breakdown] Post-confirmation state detected", {
		accepted,
	});
	return { isAfter: true, accepted };
}

/**
 * Sanitize messages for the model API call.
 *
 * CopilotKit often sends back malformed message history:
 * - AI messages split into content-only and tool_calls-only messages
 * - Missing tool responses (e.g., write_document_local response dropped)
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
		console.warn("[Story Breakdown] Dropped trailing assistant turn(s)", {
			dropped: droppedTurns,
		});
	}

	console.log("[Story Breakdown] Sanitized messages for model", {
		inputCount: messages.length,
		outputCount: shaped.length,
		outputTypes: shaped.map((m) => getMessageType(m)),
	});

	return shaped;
}

/**
 * Breakdown node for story generation
 *
 * Features:
 * - PRD analysis and story extraction
 * - AG-UI protocol predictive updates
 * - Automatic retry on transient failures
 *
 * @param state - Current agent state
 * @param config - Runnable configuration
 * @returns Command to update state and route to next node
 */
export async function breakdownNode(
	state: StoryBreakdownStateType,
	config?: RunnableConfig,
): Promise<Command> {
	try {
		const generationStart = Date.now();
		// =====================================================================
		// POST-CONFIRMATION HANDLING
		// =====================================================================
		// After user clicks Accept/Reject, CopilotKit sends a tool response back.
		// We detect this and return a simple acknowledgment WITHOUT calling tools.
		// This prevents the infinite confirm_changes loop.
		const confirmationStatus = isAfterConfirmation(state.messages);
		if (confirmationStatus.isAfter) {
			console.log("[Story Breakdown] Handling post-confirmation", {
				accepted: confirmationStatus.accepted,
			});

			// Create a simple acknowledgment message (no tool calls!)
			const acknowledgment = confirmationStatus.accepted
				? "Features have been applied to the document."
				: "Features have been discarded. The document remains unchanged.";

			const ackMessage = new AIMessage({ content: acknowledgment });

			return new Command({
				goto: END,
				update: {
					messages: [...state.messages, ackMessage],
					error: undefined,
				},
			});
		}

		// Validate state
		if (!state.prdContent) {
			throw new Error("No PRD content provided");
		}

		// Check retry limit
		if (state.retryCount >= MAX_RETRIES) {
			console.error("[Story Breakdown] Max retries exceeded", {
				retryCount: state.retryCount,
				maxRetries: MAX_RETRIES,
			});
			return new Command({
				goto: END,
				update: {
					error: "Maximum retry attempts exceeded. Please try again later.",
					messages: state.messages,
				},
			});
		}

		// Extract provider config from runtime config
		let providerConfig: ProviderConfig | undefined;
		if (config?.configurable) {
			const configurable = config.configurable as Record<string, unknown>;
			if (configurable.ai_api_key && configurable.ai_model) {
				providerConfig = {
					apiKey: String(configurable.ai_api_key),
					model: String(configurable.ai_model),
					provider: configurable.ai_provider
						? String(configurable.ai_provider)
						: undefined,
					baseUrl: configurable.ai_gateway_url
						? String(configurable.ai_gateway_url)
						: undefined,
					// Canonical-derived reasoning signal (Bug #1942 review): gates
					// Databricks <think> stripping when the serving alias is opaque.
					isReasoningModel:
						typeof configurable.ai_is_reasoning === "boolean"
							? configurable.ai_is_reasoning
							: undefined,
				};
			}
		}

		// Create model with provider config (falls back to env var if not provided)
		const model = getAgentModel(providerConfig, {
			temperature: 0.3,
			maxTokens: 8000,
			retryCount: state.retryCount,
		});

		console.log(
			"[Story Breakdown] Using model:",
			providerConfig?.model || "groq/llama-3.3-70b-versatile (env)",
		);

		// Use custom system prompt if provided
		let systemPrompt = state.systemPrompt || getDefaultSystemPrompt();

		// Apply Fabric AI prompt enhancement
		// Auto-detects patterns like "agility_story" for feature breakdowns
		try {
			const fabricResult = await detectAndCompose({
				userMessage: state.prdContent,
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
					"[Story Breakdown] Fabric AI enhancement applied:",
					{
						pattern: fabricResult.components.pattern,
						context: fabricResult.components.context,
						strategy: fabricResult.components.strategy,
					},
				);
			}
		} catch (error) {
			console.warn(
				"[Story Breakdown] Fabric AI enhancement failed, using base prompt:",
				error,
			);
		}

		// Build user message
		const userMessage = buildUserMessage(
			state.projectName,
			state.projectDescription,
			state.prdContent,
		);

		// Configure predictive state updates
		const runnableConfig = config ?? {};

		if (!runnableConfig.metadata) {
			runnableConfig.metadata = {};
		}
		runnableConfig.metadata.predict_state = getPredictStateConfig();

		// Bind tools to model
		if (!model.bindTools) {
			throw new Error(
				"[Story Breakdown] Model does not support tool binding. Please configure a model with function calling support.",
			);
		}
		// Only bind write_document_local - like ag-ui-demo
		const modelWithTools = model.bindTools([WRITE_DOCUMENT_TOOL], {
			parallel_tool_calls: false,
		} as Record<string, unknown>);

		// Sanitize messages: strip tool_calls, tool messages, merge consecutive AI
		// messages to prevent Anthropic 400 errors from malformed CopilotKit history
		const filteredMessages = sanitizeMessagesForModel(state.messages);

		const messages = [
			new SystemMessage(systemPrompt),
			...filteredMessages,
			new HumanMessage(userMessage),
		];

		console.log("[Story Breakdown] Generating features", {
			projectName: state.projectName,
			prdContentLength: state.prdContent?.length || 0,
			retryCount: state.retryCount,
		});

		// Invoke the model. turnStart is captured BEFORE invoke per
		// buildReasoningUpdate protocol P3 (otherwise durationMs ≈ 0).
		const turnStart = Date.now();
		const response = await modelWithTools.invoke(messages, runnableConfig);
		await logAgentUsageFromRunnableConfig(runnableConfig, response, {
			taskType: "TOOL_CALLING",
			agentId: "story_breakdown",
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
			loggerLabel: "[Story Breakdown]",
		});
		stripRawResponseEnvelope(response);

		if (reasoningByTurnUpdate.reasoningByTurn) {
			const turnIndex = countHumanMessages(state.messages);
			const entry = reasoningByTurnUpdate.reasoningByTurn[turnIndex];
			console.log("[Story Breakdown] Reasoning emitted", {
				turnIndex,
				textLength: entry?.text.length ?? 0,
				durationMs: entry?.durationMs ?? 0,
			});
		}

		console.log("[Story Breakdown] Model response received", {
			hasToolCalls:
				!!response.tool_calls && response.tool_calls.length > 0,
			toolCallCount: response.tool_calls?.length || 0,
		});

		// Update messages with response
		const updatedMessages = [...state.messages, response];

		// Handle tool calls
		if (response.tool_calls && response.tool_calls.length > 0) {
			const toolCall = response.tool_calls[0];

			if (toolCall.name === "write_document_local") {
				// Validate tool call arguments
				if (!toolCall.args || !toolCall.args.document) {
					const truncated = isOutputTruncated(response);
					console.error(
						"[Story Breakdown] Invalid tool call arguments",
						{
							toolCall,
							retryCount: state.retryCount,
							stopReason: resolveStopReason(response),
						},
					);

					// A generation truncated at the model's output-token limit has
					// deterministically incomplete args — a corrective message can't
					// fix that, so skip straight to the terminal error instead of
					// burning MAX_RETRIES identical, guaranteed-to-fail generations.
					if (!truncated && state.retryCount < MAX_RETRIES) {
						// Instead of throwing (which retries blindly with same messages),
						// add corrective feedback so the model sees its mistake on retry.
						// Use HumanMessage because sanitizeMessagesForModel strips all ToolMessages.
						const correctionMessage = new HumanMessage({
							content:
								'ERROR: Your previous write_document_local call had empty arguments. You MUST include the "document" parameter with the full document content as a markdown string. Please call write_document_local again with the document content.',
						});

						console.log(
							"[Story Breakdown] Retrying with corrective message",
							{ retryCount: state.retryCount + 1 },
						);

						return new Command({
							goto: "breakdown" as typeof END,
							update: {
								messages: [
									...updatedMessages,
									correctionMessage,
								],
								retryCount: state.retryCount + 1,
								...reasoningByTurnUpdate,
							},
						});
					}

					// Max retries exhausted, or the generation was truncated —
					// return a user-facing error.
					console.error(
						"[Story Breakdown] Max retries reached for empty tool call args",
						{ retryCount: state.retryCount, truncated },
					);
					const emptyArgsError = truncated
						? "The document is too large for the AI model's output limit, so it could not return the full content. Try asking for a smaller, targeted edit, or switch to a model with a larger output limit."
						: "The AI model was unable to generate the stories after multiple attempts. Please try again or use a different model.";
					return new Command({
						goto: END,
						update: {
							messages: [
								...state.messages,
								{
									role: "assistant" as const,
									content: emptyArgsError,
								},
							],
							error: emptyArgsError,
							retryCount: 0,
							...reasoningByTurnUpdate,
						},
					});
				}

				console.log("[Story Breakdown] Stories generated", {
					documentLength: toolCall.args.document.length,
				});

				// Add tool response
				const toolResponse = {
					role: "tool" as const,
					content: "Features document written.",
					tool_call_id: toolCall.id,
				};

				// Generate a follow-up message for story breakdown
				// Models often return empty content with tool calls, so we generate our own
				const followUpOptions = [
					"Would you like me to break down any of these features into smaller tasks?",
					"Should I add more detailed acceptance criteria for the critical features?",
					"Would you like me to identify dependencies between these features?",
					"Should I prioritize these features for sprint planning?",
				];
				const randomFollowUp =
					followUpOptions[
						Math.floor(Math.random() * followUpOptions.length)
					];
				const followUpMessage = `I've generated the features. ${randomFollowUp}`;

				// Add confirmation
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

				return new Command({
					goto: END,
					update: {
						messages: [
							...updatedMessages,
							toolResponse,
							confirmToolCall,
						],
						document: toolCall.args.document,
						focusAnchor: toolCall.args.focusAnchor,
						error: undefined,
						retryCount: 0, // Reset on success
						...reasoningByTurnUpdate,
					},
				});
			}
		}

		// Fallback: use response content directly
		console.warn("[Story Breakdown] No tool call in response");
		const document = response.content?.toString() || "";

		return new Command({
			goto: END,
			update: {
				messages: updatedMessages,
				document,
				error: undefined,
				...reasoningByTurnUpdate,
			},
		});
	} catch (error) {
		console.error("[Story Breakdown] Error:", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			retryCount: state.retryCount,
		});

		// Handle retryable errors
		if (error instanceof Error && isRetryableError(error)) {
			const maxRetries = isJsonParseError(error)
				? MAX_RETRIES + 1
				: MAX_RETRIES;

			if (state.retryCount < maxRetries) {
				const delay = calculateRetryDelay(state.retryCount);
				console.log(
					`[Story Breakdown] Retrying in ${delay}ms (attempt ${state.retryCount + 1}/${maxRetries})`,
				);

				await sleep(delay);

				return new Command({
					goto: "breakdown" as typeof END,
					update: {
						retryCount: state.retryCount + 1,
						error: `Retrying... (attempt ${state.retryCount + 1}/${maxRetries})`,
					},
				});
			}
		}

		return new Command({
			goto: END,
			update: {
				messages: state.messages,
				error: error instanceof Error ? error.message : "Unknown error",
				retryCount: state.retryCount + 1,
			},
		});
	}
}
