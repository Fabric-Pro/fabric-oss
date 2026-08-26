/**
 * Chat Node
 *
 * Main node for document generation following the ag-ui-demo pattern.
 *
 * Key behaviors:
 * - Always streams document content via predictive state updates
 * - Model generates summary alongside tool call (in response.content)
 * - After write_document_local, adds confirm_changes tool call and ends
 * - Detects post-confirmation state and outputs summary only (no tool calls)
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
import { logAgentUsageFromRunnableConfig } from "@repo/agent-core";
import { shapeHistoryForModel } from "@repo/agent-core/message-shape";
import {
	hoistRawStopReason,
	isOutputTruncated,
	resolveStopReason,
} from "@repo/agent-core/output-truncation";
import {
	buildReasoningUpdate,
	countHumanMessages,
	extractTextFromContent,
	stripRawResponseEnvelope,
} from "@repo/agent-core/reasoning-trace";
import {
	generateFollowUpQuestions,
	getDocumentSections,
	validateDocument,
} from "@repo/agent-prompts";
import { WRITE_DOCUMENT_TOOL } from "@repo/agent-tools";
import { logger } from "@repo/logs";
import { v4 as uuidv4 } from "uuid";
import { buildSystemPrompt, getPredictStateConfig } from "../prompts";
import type { AgentState } from "../state";
import {
	calculateRetryDelay,
	getAgentModelAsync,
	isJsonParseError,
	isRetryableError,
	MAX_RETRIES,
	sleep,
} from "../utils";

/**
 * Image-context handling: the upload pipeline encodes uploaded images as
 * `[Uploaded Image: name]\n![name](data:image/...;base64,…)` entries inside
 * `state.ragContexts` so the markdown survives the readable + state channels.
 * That string-shaped envelope is fine for text-only models, but a
 * vision-capable model needs the data URL surfaced as an `image_url` content
 * part on a `HumanMessage` — otherwise the model just sees raw base64 in the
 * system prompt and answers "I can't read the image".
 *
 * `splitRagContextImages` walks each rag-context entry, peels out every
 * `data:image/...` data URL it finds (in standard markdown image syntax), and
 * returns:
 *   - `textOnlyContexts`: the same entries with the data-URL portion of
 *     each image stripped, leaving the human-readable label
 *     (`[Uploaded Image: name]\n![name](image attached separately)`) so the
 *     prompt builder can still reference the file by name.
 *   - `images`: `{ filename, dataUrl }[]` to attach as `image_url` parts.
 */
const IMAGE_DATA_URL_RE =
	/!\[([^\]]*)\]\((data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+)\)/g;

/** Output-token budget requested for an ordinary turn. */
const DEFAULT_OUTPUT_MAX_TOKENS = 16_000;

/**
 * Output-token budget for the single truncation-recovery retry (issue #2976).
 *
 * A reasoning-capable model bills its invisible thinking against the same
 * `max_tokens` as the visible answer, so a turn can spend the entire budget
 * reasoning and return nothing at all. Retrying on the SAME budget is
 * deterministic — it reproduces the same truncation — so the one retry asks
 * for double. `resolveOutputTokenBudget`
 * (`@repo/agent-core/services/langchain-models`) still clamps this to the
 * resolved model's catalog `maxOutputTokens`, so a model with a smaller
 * ceiling is never asked for more than it accepts.
 */
const TRUNCATION_RETRY_MAX_TOKENS = 32_000;

/**
 * User-facing message for a turn that returned nothing because the model hit
 * its output-token limit before emitting a single visible token, both on the
 * original budget and on the escalated retry (issue #2976). Exported so the
 * regression test can lock the copy.
 */
export const TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE =
	"The AI model ran out of output budget before it could write anything — it spent the whole response on internal reasoning, and a retry with a larger budget hit the same limit. Your document has not been changed. Try a narrower request (one section at a time works well), start a fresh conversation so there's less history to reason over, or ask an admin to configure a model with a larger output limit.";

/**
 * True when the model returned nothing usable: no tool calls and no text
 * content. Combined with {@link isOutputTruncated} this is the signature of
 * issue #2976 — the whole output budget spent on invisible reasoning, with no
 * visible tokens emitted. A response carrying partial text, or a tool call
 * (even one with unusable args — the empty-args branch owns that case), is NOT
 * empty.
 */
function isEmptyModelResponse(response: {
	content?: unknown;
	tool_calls?: unknown;
}): boolean {
	const toolCalls = response.tool_calls;
	if (Array.isArray(toolCalls) && toolCalls.length > 0) {
		return false;
	}
	return extractTextFromContent(response.content).trim().length === 0;
}

function splitRagContextImages(ragContexts: readonly string[] | undefined): {
	textOnlyContexts: string[];
	images: Array<{ filename: string; dataUrl: string }>;
} {
	const images: Array<{ filename: string; dataUrl: string }> = [];
	const textOnlyContexts: string[] = [];
	if (!ragContexts || ragContexts.length === 0) {
		return { textOnlyContexts, images };
	}
	for (const ctx of ragContexts) {
		IMAGE_DATA_URL_RE.lastIndex = 0;
		// Plain-text placeholder so an echo into model output renders harmlessly
		// in the persisted document instead of as a broken-image markdown link.
		const cleaned = ctx.replace(IMAGE_DATA_URL_RE, (_, name, dataUrl) => {
			images.push({ filename: name || "image", dataUrl });
			return `[attached image: ${name || "image"}]`;
		});
		textOnlyContexts.push(cleaned);
	}
	return { textOnlyContexts, images };
}

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
 *
 * SIMPLE RULE: Post-confirmation is ONLY when the LAST message is a tool response
 * to confirm_changes. Any other last message (human, ai, etc.) means process normally.
 *
 * Message pattern after confirmation:
 * [..., AIMessage(confirm_changes tool_call), ToolMessage(accepted: true/false)]
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

	// Log what we're checking
	logger.info("[Document Generator] isAfterConfirmation check", {
		lastMsgType: getMessageType(lastMsg),
		lastMsgContent:
			typeof lastMsg.content === "string"
				? lastMsg.content.slice(0, 50)
				: "(non-string)",
		secondLastMsgType: getMessageType(secondLastMsg),
		hasToolCalls:
			!!(secondLastMsg as any).tool_calls ||
			!!(secondLastMsg as any).toolCalls,
	});

	// Check if last message is a tool response
	if (getMessageType(lastMsg) !== "tool") {
		return { isAfter: false, accepted: false };
	}

	// Check if the tool response contains "accepted" (from confirm_changes)
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
	if (!toolCalls || toolCalls.length === 0) {
		return { isAfter: false, accepted: false };
	}

	const hasConfirmChanges = toolCalls.some((tc: any) => {
		const name = tc.name || tc.function?.name;
		return name === "confirm_changes";
	});

	if (!hasConfirmChanges) {
		return { isAfter: false, accepted: false };
	}

	// Parse the acceptance status from the tool response
	const accepted =
		content.includes('"accepted":true') ||
		content.includes('"accepted": true');

	logger.info("[Document Generator] Post-confirmation state detected", {
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
 * The model gets the current document via the system prompt, so it doesn't
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
		// missing or malformed after CopilotKit processing. EXCEPTION: an
		// ask_clarifying_question answer is converted to a user message so the
		// model can continue with the user's choice (everything else stripped).
		if (msgType === "tool") {
			const answerText = clarifyingAnswerToText(
				(msg as { content?: unknown }).content,
			);
			if (answerText) {
				const last =
					result.length > 0 ? result[result.length - 1] : null;
				if (
					last &&
					getMessageType(last) === "human" &&
					typeof last.content === "string"
				) {
					result[result.length - 1] = new HumanMessage({
						content: `${last.content}\n\n${answerText}`,
					});
				} else {
					result.push(new HumanMessage({ content: answerText }));
				}
			}
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
		logger.warn("[Document Generator] Dropped trailing assistant turn(s)", {
			dropped: droppedTurns,
		});
	}

	logger.info("[Document Generator] Sanitized messages for model", {
		inputCount: messages.length,
		outputCount: shaped.length,
		outputTypes: shaped.map((m) => getMessageType(m)),
	});

	return shaped;
}

/**
 * Detect a clarifying question the model emitted as a fenced `clarifying-question`
 * JSON block (the shared follow-up prompt instructs this). This agent only binds
 * write_document_local, so — like the synthetic confirm_changes call — we parse
 * the block and synthesize an ask_clarifying_question tool call ourselves so the
 * frontend renders the interactive card. Lenient: fenced or bare JSON, requires a
 * non-empty question, caps options at 3. Returns null when it is not a block.
 */
export function extractClarifyingQuestion(
	text: string,
): { question: string; options: string[] } | null {
	if (!text) {
		return null;
	}
	const candidates: string[] = [];
	const fenceRe = /```[a-zA-Z-]*\s*([\s\S]*?)```/g;
	let m: RegExpExecArray | null = fenceRe.exec(text);
	while (m !== null) {
		candidates.push(m[1]);
		m = fenceRe.exec(text);
	}
	candidates.push(text); // bare-JSON fallback
	for (const raw of candidates) {
		const trimmed = raw.trim();
		if (!trimmed.startsWith("{")) {
			continue;
		}
		try {
			const obj = JSON.parse(trimmed) as {
				question?: unknown;
				options?: unknown;
			};
			const question =
				typeof obj.question === "string" ? obj.question.trim() : "";
			if (!question) {
				continue;
			}
			const options = Array.isArray(obj.options)
				? obj.options
						.filter(
							(o): o is string =>
								typeof o === "string" && o.trim() !== "",
						)
						.map((o) => o.trim())
						.slice(0, 3)
				: [];
			return { question, options };
		} catch {
			// Not valid JSON — try the next candidate.
		}
	}
	return null;
}

/**
 * Convert an ask_clarifying_question answer (the tool result the card resolves
 * with) into plain user-message text. This agent's sanitizer strips ALL tool
 * messages, so without this the model would never see the user's answer.
 * Returns null for any non-clarifying tool message (left to be stripped).
 */
function clarifyingAnswerToText(content: unknown): string | null {
	const text = typeof content === "string" ? content : String(content || "");
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) {
		return null;
	}
	try {
		const obj = JSON.parse(trimmed) as {
			answered?: boolean;
			answer?: unknown;
			dismissed?: boolean;
		};
		if (
			obj &&
			typeof obj === "object" &&
			("answered" in obj || "dismissed" in obj)
		) {
			if (obj.dismissed === true || obj.answered === false) {
				return "I dismissed the clarifying question — note it as an open question and proceed with a reasonable default.";
			}
			if (typeof obj.answer === "string" && obj.answer.trim()) {
				return `My answer to your clarifying question: ${obj.answer.trim()}`;
			}
		}
	} catch {
		// Not the clarifying-answer shape.
	}
	return null;
}

/**
 * Chat node following ag-ui-demo pattern
 *
 * Flow:
 * 1. Build system prompt with current document state
 * 2. Invoke model with write_document_local tool
 * 3. Model streams document via predictive state AND generates summary in content
 * 4. Add tool response and confirm_changes tool call
 * 5. Return to END - frontend handles confirmation locally
 *
 * @param state - Current agent state
 * @param config - Runnable configuration
 * @returns Command to update state and route to end
 */
export async function chatNode(
	state: AgentState,
	config?: RunnableConfig,
): Promise<Command> {
	// Snapshot the document before any model call. `predict_state` streams
	// partial `write_document_local` arguments straight into `state.document`
	// as they arrive, so a generation cut off mid-arguments can leave a
	// fragment behind — the terminal truncation branch restores this value so
	// "your document has not been changed" is actually true.
	const preGenerationDocument = state.document;
	try {
		const generationStart = Date.now();
		// Validate state
		if (!state.messages || state.messages.length === 0) {
			throw new Error("No messages in state");
		}

		logger.info("[Document Generator] chatNode invoked", {
			documentLength: state.document?.length || 0,
			documentPreview: state.document?.slice(0, 200) || "(empty)",
			hasDocument: !!state.document && state.document.trim().length > 0,
			messageCount: state.messages.length,
		});

		// =====================================================================
		// POST-CONFIRMATION HANDLING
		// =====================================================================
		// After user clicks Accept/Reject, CopilotKit sends a tool response back.
		// We detect this and return a simple acknowledgment WITHOUT calling tools.
		// This prevents the infinite confirm_changes loop.
		const confirmationStatus = isAfterConfirmation(state.messages);
		if (confirmationStatus.isAfter) {
			logger.info("[Document Generator] Handling post-confirmation", {
				accepted: confirmationStatus.accepted,
			});

			// Create a simple acknowledgment message (no tool calls!)
			const acknowledgment = confirmationStatus.accepted
				? "Changes have been applied to the document."
				: "Changes have been discarded. The document remains unchanged.";

			const ackMessage = new AIMessage({ content: acknowledgment });

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
			logger.error("[Document Generator] Max retries exceeded", {
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

		// Peel image data URLs out of the rag-contexts so we can surface them
		// as proper `image_url` content parts on the user message instead of
		// burying base64 in the system prompt (where the model treats it as
		// text and answers "I can't read the image"). Text-only contexts feed
		// the prompt builder; the extracted images are attached to the last
		// HumanMessage below if the configured model is vision-capable.
		const { textOnlyContexts, images } = splitRagContextImages(
			state.ragContexts,
		);

		// Build system prompt
		const systemPrompt = buildSystemPrompt(
			state.systemPrompt,
			state.documentType || "general",
			state.document,
			state.projectContext,
			textOnlyContexts,
		);

		logger.info("[Document Generator] Building prompt", {
			hasProjectContext: !!state.projectContext,
			hasRagContexts: !!state.ragContexts && state.ragContexts.length > 0,
			ragContextCount: state.ragContexts?.length || 0,
			imageCount: images.length,
			systemPromptLength: systemPrompt.length,
		});

		// Create model using provider config
		const model = await getAgentModelAsync(config, {
			temperature: 0.5,
			maxTokens: DEFAULT_OUTPUT_MAX_TOKENS,
			retryCount: state.retryCount,
			taskType: "TOOL_CALLING",
		});

		const modelName =
			config?.configurable?.ai_model || "provider-configured";
		logger.info("[Document Generator] Using model", { modelName });

		// Configure runnable with predict_state for streaming
		const runnableConfig = config ?? {};

		if (!runnableConfig.metadata) {
			runnableConfig.metadata = {};
		}

		// Always enable predictive state streaming (ag-ui-demo pattern)
		runnableConfig.metadata.predict_state = getPredictStateConfig();

		// Bind tools to the model
		if (!model.bindTools) {
			throw new Error(
				"[Document Generator] Model does not support tool binding",
			);
		}

		// Only bind write_document_local - like ag-ui-demo
		// Do NOT use tool_choice to force - model needs freedom to not call tool
		// when receiving confirmation responses
		const modelWithTools = model.bindTools([WRITE_DOCUMENT_TOOL], {
			parallel_tool_calls: false,
		} as Record<string, unknown>);

		logger.info("[Document Generator] Bound tools", {
			toolCount: 1,
			toolNames: ["write_document_local"],
		});

		// Sanitize messages: strip tool_calls, tool messages, merge consecutive AI
		// messages to prevent Anthropic 400 errors from malformed CopilotKit history
		const filteredMessages = sanitizeMessagesForModel(state.messages);

		// If we extracted any image data URLs, attach them as `image_url`
		// content parts on the final HumanMessage. We do NOT gate on a model
		// whitelist — the tenant's configured model is the source of truth,
		// and a non-vision model will surface a clear API error rather than
		// silently dropping the image. Most modern provider/model
		// combinations the platform supports accept `image_url` parts.
		const messagesForModel: BaseMessage[] = [...filteredMessages];
		if (images.length > 0) {
			let lastHumanIdx = -1;
			for (let i = messagesForModel.length - 1; i >= 0; i--) {
				if (getMessageType(messagesForModel[i]) === "human") {
					lastHumanIdx = i;
					break;
				}
			}
			const baseText =
				lastHumanIdx >= 0
					? typeof messagesForModel[lastHumanIdx].content === "string"
						? (messagesForModel[lastHumanIdx].content as string)
						: ""
					: "";
			const multimodal = new HumanMessage({
				content: [
					{ type: "text", text: baseText || "(see attached images)" },
					...images.map((img) => ({
						type: "image_url" as const,
						image_url: { url: img.dataUrl },
					})),
				],
			});
			if (lastHumanIdx >= 0) {
				messagesForModel[lastHumanIdx] = multimodal;
			} else {
				messagesForModel.push(multimodal);
			}
		}

		logger.info("[Document Generator] Invoking model", {
			messageCount: messagesForModel.length,
			documentLength: state.document?.length || 0,
			documentType: state.documentType || "general",
			imagesAttached: images.length,
			modelId: modelName,
		});

		// Invoke the model. Provider errors propagate as-is; the frontend
		// interceptor (CopilotFetchErrorInterceptor) surfaces them as
		// toasts. turnStart is captured BEFORE invoke per
		// buildReasoningUpdate protocol P3 (otherwise durationMs ≈ 0).
		const turnStart = Date.now();
		const requestMessages = [
			new SystemMessage({ content: systemPrompt }),
			...messagesForModel,
		];
		let response = await modelWithTools.invoke(
			requestMessages,
			runnableConfig,
		);
		await logAgentUsageFromRunnableConfig(runnableConfig, response, {
			taskType: "TOOL_CALLING",
			agentId: "document_generator",
			latencyMs: Date.now() - generationStart,
		});

		// Lift the gateway's stop/finish reason out of the raw response envelope
		// before `stripRawResponseEnvelope` below removes it. Without this the
		// truncation checks here are blind on gateways whose `response_metadata`
		// carries no stop reason under any name — the Databricks-served Anthropic
		// path is the confirmed case. See `hoistRawStopReason` in
		// @repo/agent-core/output-truncation.
		hoistRawStopReason(response);

		// === Truncation recovery (issue #2976) ===
		// A reasoning-capable model bills invisible thinking against the same
		// output budget as the visible answer, so a turn can come back truncated
		// with no content AND no tool calls. Left alone that falls through to the
		// "no tool call" branch at the bottom of this node, which ends the run
		// reporting success while the document is untouched. Retry ONCE with
		// double the budget — a same-budget retry is deterministic and reproduces
		// the same truncation.
		//
		// The failed attempt's reasoning is extracted before `response` is
		// replaced: that trace is the only record of what the model spent its
		// whole budget thinking about, and the response object holding it is
		// discarded here rather than appended to `messages`.
		let carriedReasoningUpdate: ReturnType<typeof buildReasoningUpdate> =
			{};
		if (isEmptyModelResponse(response) && isOutputTruncated(response)) {
			carriedReasoningUpdate = buildReasoningUpdate({
				response,
				existingByTurn: state.reasoningByTurn,
				stateMessages: state.messages,
				turnStart,
				loggerLabel: "[Document Generator]",
			});

			logger.warn(
				"[Document Generator] Empty truncated response — retrying once with an escalated output budget",
				{
					stopReason: resolveStopReason(response),
					previousMaxTokens: DEFAULT_OUTPUT_MAX_TOKENS,
					retryMaxTokens: TRUNCATION_RETRY_MAX_TOKENS,
					usage: response.usage_metadata,
					messageCount: state.messages.length,
				},
			);

			const retryModel = await getAgentModelAsync(config, {
				temperature: 0.5,
				maxTokens: TRUNCATION_RETRY_MAX_TOKENS,
				retryCount: state.retryCount,
				taskType: "TOOL_CALLING",
			});
			if (!retryModel.bindTools) {
				throw new Error(
					"[Document Generator] Model does not support tool binding",
				);
			}
			const retryModelWithTools = retryModel.bindTools(
				[WRITE_DOCUMENT_TOOL],
				{ parallel_tool_calls: false } as Record<string, unknown>,
			);
			response = await retryModelWithTools.invoke(
				requestMessages,
				runnableConfig,
			);
			await logAgentUsageFromRunnableConfig(runnableConfig, response, {
				taskType: "TOOL_CALLING",
				agentId: "document_generator:truncation_retry",
				latencyMs: Date.now() - generationStart,
			});
			hoistRawStopReason(response);

			logger.warn(
				"[Document Generator] Truncation-recovery retry completed",
				{
					stopReason: resolveStopReason(response),
					recovered: !isEmptyModelResponse(response),
					toolCallCount: response.tool_calls?.length || 0,
					usage: response.usage_metadata,
				},
			);
		}

		// === Reasoning capture (shared lib, F-1171 follow-up) ===
		// buildReasoningUpdate MUST run BEFORE stripRawResponseEnvelope —
		// see protocol P1 in @repo/agent-core/reasoning-trace/emit.ts.
		//
		// `existingByTurn` carries the truncation-recovery retry's discarded
		// first attempt so its reasoning coalesces with the retry's instead of
		// being overwritten; when the retry emits none of its own, the carried
		// update is used directly. Both are `{}` on an ordinary turn.
		const responseReasoningUpdate = buildReasoningUpdate({
			response,
			existingByTurn:
				carriedReasoningUpdate.reasoningByTurn ?? state.reasoningByTurn,
			stateMessages: state.messages,
			turnStart,
			loggerLabel: "[Document Generator]",
		});
		const reasoningByTurnUpdate = responseReasoningUpdate.reasoningByTurn
			? responseReasoningUpdate
			: carriedReasoningUpdate;
		stripRawResponseEnvelope(response);

		if (reasoningByTurnUpdate.reasoningByTurn) {
			const turnIndex = countHumanMessages(state.messages);
			const entry = reasoningByTurnUpdate.reasoningByTurn[turnIndex];
			logger.info("[Document Generator] Reasoning emitted", {
				turnIndex,
				textLength: entry?.text.length ?? 0,
				durationMs: entry?.durationMs ?? 0,
			});
		}

		logger.info("[Document Generator] Model response received", {
			hasToolCalls:
				!!response.tool_calls && response.tool_calls.length > 0,
			toolCallCount: response.tool_calls?.length || 0,
			hasContent: !!response.content,
			contentPreview:
				typeof response.content === "string"
					? response.content.substring(0, 200)
					: JSON.stringify(response.content)?.substring(0, 200),
		});

		// The model signals a clarifying question as a fenced clarifying-question
		// block (per the shared follow-up prompt) rather than a tool call (it only
		// binds write_document_local). Synthesize the ask_clarifying_question tool
		// call onto the response so the frontend renders the card; the graph is
		// chat_node -> END, so it surfaces and waits for the user's answer.
		if (!response.tool_calls || response.tool_calls.length === 0) {
			const clarifyingText =
				typeof response.content === "string"
					? response.content
					: Array.isArray(response.content)
						? response.content
								.map((p: any) =>
									typeof p === "string" ? p : p?.text || "",
								)
								.join("")
						: "";
			const clarifying = extractClarifyingQuestion(clarifyingText);
			if (clarifying) {
				(response as { tool_calls?: unknown }).tool_calls = [
					{
						id: uuidv4(),
						name: "ask_clarifying_question",
						args: {
							question: clarifying.question,
							options: clarifying.options,
						},
						type: "tool_call" as const,
					},
				];
				// The card represents the question; drop the raw block text.
				(response as { content?: unknown }).content = "";
				logger.info(
					"[Document Generator] Synthesized ask_clarifying_question from clarifying-question block",
					{ optionCount: clarifying.options.length },
				);
			}
		}

		// Update messages with response (includes any summary in response.content)
		const messages = [...state.messages, response];

		// Handle tool calls
		if (response.tool_calls && response.tool_calls.length > 0) {
			const toolCall = response.tool_calls[0];

			// Synthesized clarifying-question card: surface it (the AI message with
			// the tool_call is already in `messages`) and end the run so the frontend
			// renders the card and waits. The answer arrives next turn as a tool
			// result, which the sanitizer converts into a user message.
			if (toolCall.name === "ask_clarifying_question") {
				return new Command({
					goto: END,
					update: {
						messages,
						error: undefined,
						...reasoningByTurnUpdate,
					},
				});
			}

			if (toolCall.name === "write_document_local") {
				// Validate tool call arguments
				if (!toolCall.args || !toolCall.args.document) {
					const truncated = isOutputTruncated(response);
					logger.error(
						"[Document Generator] Invalid tool call arguments",
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

						logger.info(
							"[Document Generator] Retrying with corrective message",
							{ retryCount: state.retryCount + 1 },
						);

						return new Command({
							goto: "chat_node" as typeof END,
							update: {
								messages: [...messages, correctionMessage],
								retryCount: state.retryCount + 1,
								...reasoningByTurnUpdate,
							},
						});
					}

					// Max retries exhausted, or the generation was truncated —
					// return a user-facing error.
					logger.error(
						"[Document Generator] Max retries reached for empty tool call args",
						{ retryCount: state.retryCount, truncated },
					);
					const emptyArgsError = truncated
						? "The document is too large for the AI model's output limit, so it could not return the full content. Try asking for a smaller, targeted edit, or switch to a model with a larger output limit."
						: "The AI model was unable to generate the document after multiple attempts. Please try again or use a different model.";
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

				const document = toolCall.args.document;
				const documentType = state.documentType || "general";

				// Pre-stream validation (non-blocking)
				try {
					const requiredSections = getDocumentSections(documentType)
						.filter((s) => s.required)
						.map((s) => s.name);

					const validation = validateDocument(
						document,
						documentType,
						requiredSections.length > 0
							? requiredSections
							: undefined,
						state.ragContexts || [],
						state.document,
					);

					if (!validation.isValid && validation.errors.length > 0) {
						logger.warn(
							"[Document Generator] Document validation failed",
							{
								errors: validation.errors,
								score: validation.score,
							},
						);
					} else {
						logger.info(
							"[Document Generator] Document validation passed",
							{
								score: validation.score,
								warnings: validation.warnings.length,
							},
						);
					}
				} catch (validationError) {
					logger.warn(
						"[Document Generator] Validation error (non-fatal)",
						{ error: validationError },
					);
				}

				logger.info("[Document Generator] Document written", {
					documentLength: document.length,
				});

				// Add tool response
				const toolResponse = {
					role: "tool" as const,
					content: "Document written.",
					tool_call_id: toolCall.id,
				};

				// Use the model's response content if available (LLM-generated contextual follow-up)
				// Only fall back to programmatic generation if model returned empty content
				const modelContent =
					typeof response.content === "string"
						? response.content.trim()
						: "";

				let followUpMessage: string;
				if (modelContent.length > 0) {
					// Model provided a contextual response - use it directly
					followUpMessage = modelContent;
					logger.info(
						"[Document Generator] Using model-generated follow-up",
						{
							contentLength: modelContent.length,
							preview: modelContent.substring(0, 100),
						},
					);
				} else {
					// Fallback: Generate programmatically if model returned empty content
					const followUpQuestions = generateFollowUpQuestions({
						documentType,
						document,
						maxQuestions: 1,
						isNewDocument:
							!state.document ||
							state.document.trim().length === 0,
					});
					followUpMessage =
						followUpQuestions.length > 0
							? `I've updated the document. ${followUpQuestions[0]}`
							: "I've updated the document. Let me know if you'd like any changes.";
					logger.info(
						"[Document Generator] Using programmatic follow-up (model returned empty)",
						{
							question: followUpQuestions[0] || "(none)",
						},
					);
				}

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
					goto: END,
					update: {
						messages: [...messages, toolResponse, confirmToolCall],
						document: document,
						focusAnchor: toolCall.args.focusAnchor,
						error: undefined,
						retryCount: 0,
						...reasoningByTurnUpdate,
					},
				});
			}
		}

		// Nothing came back AND the generation was cut off at its output-token
		// limit (issue #2976). The escalated retry above has already run and come
		// back the same way. Ending here with `error: undefined` would report a
		// successful run while the document is byte-identical, leaving the user
		// with the generic "I wasn't able to generate a response" fallback and no
		// hint about what to change. `error` on a terminal state IS surfaced —
		// unified-server emits it as the assistant turn.
		if (isEmptyModelResponse(response) && isOutputTruncated(response)) {
			logger.error(
				"[Document Generator] Empty truncated response after retry — ending run with a user-facing error",
				{
					stopReason: resolveStopReason(response),
					documentLength: state.document?.length || 0,
					messageCount: state.messages.length,
				},
			);
			return new Command({
				goto: END,
				update: {
					messages: [
						...state.messages,
						{
							role: "assistant" as const,
							content: TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE,
						},
					],
					// Restore the node-entry snapshot so the message above is
					// true — see `preGenerationDocument`.
					document: preGenerationDocument,
					error: TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE,
					retryCount: 0,
					...reasoningByTurnUpdate,
				},
			});
		}

		// No tool call - return current state with messages
		logger.warn("[Document Generator] No tool call in response");
		return new Command({
			goto: END,
			update: {
				messages: messages,
				error: undefined,
				...reasoningByTurnUpdate,
			},
		});
	} catch (error) {
		logger.error("[Document Generator] Error in chatNode", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			retryCount: state.retryCount,
			messageCount: state.messages?.length || 0,
		});

		// Handle retryable errors
		if (error instanceof Error && isRetryableError(error)) {
			const maxRetries = isJsonParseError(error)
				? MAX_RETRIES + 1
				: MAX_RETRIES;

			if (state.retryCount < maxRetries) {
				const delay = calculateRetryDelay(state.retryCount);
				logger.info(
					`[Document Generator] Retrying in ${delay}ms (attempt ${state.retryCount + 1}/${maxRetries})`,
				);

				await sleep(delay);

				return new Command({
					goto: "chat_node" as typeof END,
					update: {
						retryCount: state.retryCount + 1,
						error: `Retrying... (attempt ${state.retryCount + 1}/${maxRetries})`,
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
				error: `Failed to generate document: ${errorMessage}`,
				retryCount: state.retryCount + 1,
			},
		});
	}
}
