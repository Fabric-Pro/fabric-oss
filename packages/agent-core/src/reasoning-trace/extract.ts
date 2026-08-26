import type { BaseMessage } from "@langchain/core/messages";
import { isSyntheticToolImageMessage } from "../recursion";

/**
 * Determine if a message represents a human/user turn.
 *
 * Mirrors the multi-format logic of `getMessageType()` in
 * project-document-generator chat-node.ts (handles LangChain class instances
 * via `_getType()`, AG-UI `type` field, and OpenAI `role` field).
 *
 * We CANNOT use `m instanceof HumanMessage` here because LangGraph
 * deserializes state into plain objects across the graph boundary — class
 * identity is lost.
 *
 * @internal Exported for tests only.
 */
export function isHumanMessage(m: unknown): boolean {
	if (!m || typeof m !== "object") {
		return false;
	}
	// Agent-synthesized human turns (tool output that can only be delivered as
	// user-role content, e.g. images) are NOT user turns. Counting one would
	// split a single user request across several reasoning-trace turns.
	if (isSyntheticToolImageMessage(m)) {
		return false;
	}
	const obj = m as {
		_getType?: () => string;
		type?: string;
		role?: string;
	};
	if (typeof obj._getType === "function") {
		return obj._getType() === "human";
	}
	if (obj.type === "human") {
		return true;
	}
	if (obj.role === "user") {
		return true;
	}
	return false;
}

/**
 * Count human-turn messages in a message list. Used to compute the
 * current `turnIndex` for keying reasoningByTurn — independently
 * computable on both backend and frontend from the same source of truth.
 */
export function countHumanMessages(messages: BaseMessage[]): number {
	return messages.filter(isHumanMessage).length;
}

/**
 * Extract ONLY the visible-text blocks from an AIMessage's content. Used
 * to normalize multi-block array content (thinking + text, or reasoning +
 * text) into a single string for downstream consumers that read `.content`
 * as a string (e.g. tool-confirmation builders that synthesize a follow-up
 * message from the model's text).
 *
 * Returns the input unchanged when content is already a string.
 */
export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	let acc = "";
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}
		if ((block as { type?: unknown }).type === "text") {
			const t = (block as { text?: unknown }).text;
			if (typeof t === "string") {
				acc += t;
			}
		}
	}
	return acc;
}

/**
 * Extract reasoning text from the `content` field of an AIMessage produced
 * by ChatAnthropic (thinking blocks) or ChatOpenAI (reasoning blocks).
 *
 * Anthropic shape (when thinking is enabled, multi-block):
 *   content: [
 *     { type: "thinking", thinking: "..." },
 *     { type: "text", text: "..." }
 *   ]
 *
 * OpenAI o-series shape (when reasoning_effort is set):
 *   content: [
 *     { type: "reasoning", reasoning: "..." },
 *     { type: "text", text: "..." }
 *   ]
 *
 * Returns the concatenated reasoning text (empty string if none found).
 * Returns "" for string content (single-text responses without thinking).
 */
export function extractReasoningFromContent(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	let acc = "";
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}
		const blockType = (block as { type?: unknown }).type;
		if (blockType === "thinking") {
			const t = (block as { thinking?: unknown }).thinking;
			if (typeof t === "string") {
				acc += t;
			}
		} else if (blockType === "reasoning") {
			const r = (block as { reasoning?: unknown }).reasoning;
			if (typeof r === "string") {
				acc += r;
			}
		}
	}
	return acc;
}

/**
 * Extract reasoning text from a final, merged AIMessage. Composite helper
 * that prefers structured content[] blocks (ChatAnthropic thinking, ChatOpenAI
 * reasoning) via {@link extractReasoningFromContent}, then falls back to the
 * Vercel Gateway response field — looking in BOTH `choices[0].message.reasoning`
 * (non-streaming converter shape) AND `choices[0].delta.reasoning`
 * (streaming converter shape, accumulated via LangChain `_mergeDicts` over
 * chunks).
 *
 * Defensive fallback (Codex pass #1 review): also accepts
 * `choices[0].{message,delta}.reasoning_content` because some upstream
 * gateways (notably OpenRouter and a recent batch of OpenAI Responses API
 * releases) emit `reasoning_content` instead of `reasoning`. If that
 * fallback fires we emit a `console.warn` so a Vercel normalization change
 * is surfaced early.
 *
 * The streaming path matters because LangGraph's `astream_events` API
 * (used by CopilotKit / AG-UI for our agent surfaces) wraps `.invoke()` and
 * forces the underlying model into streaming mode. LangChain's converter
 * then routes through `convertCompletionsDeltaToBaseMessageChunk` which
 * stashes the raw response under `choices[0].delta`, NOT `.message`. If we
 * only checked `.message`, we'd see `reasoning_tokens > 0` in usage but the
 * reasoning text would silently never surface — which is the F-1171 staging
 * symptom that motivated the receive-side fallback.
 *
 * Content[] is preferred because those blocks carry Anthropic's cryptographic
 * thinking signatures required for multi-turn tool replay; the raw envelope
 * is plain text only.
 *
 * Contract: this is **final-message extraction**, NOT per-token UI state
 * extraction. Caller MUST pass an accumulated/final AIMessage — feeding a
 * live in-flight `AIMessageChunk` would surface partial `delta.reasoning`
 * text. {@link buildReasoningUpdate} satisfies this by calling only after
 * `await model.invoke(...)` resolves.
 *
 * Depends on `@langchain/openai`'s `convertCompletionsDeltaToBaseMessageChunk`
 * + `convertCompletionsMessageToBaseMessage` and `@langchain/core`'s
 * `AIMessageChunk.concat` + `_mergeDicts` string-concat semantics for nested
 * fields. The runtime regression test
 * `"real LangChain AIMessageChunk.concat merges delta.reasoning across chunks"`
 * is the durable guard against future library bumps changing this contract.
 */
export function extractReasoningFromMessage(message: unknown): string {
	if (!message || typeof message !== "object") {
		return "";
	}
	const m = message as {
		content?: unknown;
		additional_kwargs?: { __raw_response?: unknown };
	};
	const fromContent = extractReasoningFromContent(m.content);
	if (fromContent.length > 0) {
		return fromContent;
	}
	const raw = m.additional_kwargs?.__raw_response;
	if (!raw || typeof raw !== "object") {
		return "";
	}
	const choices = (raw as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		return "";
	}
	const first = choices[0];
	if (!first || typeof first !== "object") {
		return "";
	}
	// Non-streaming converter shape: `choices[0].message.reasoning`
	let fromMessage: string | undefined;
	const msg = (first as { message?: unknown }).message;
	if (msg && typeof msg === "object") {
		const r = (msg as { reasoning?: unknown }).reasoning;
		if (typeof r === "string" && r.length > 0) {
			fromMessage = r;
		}
		// Defensive fallback: `reasoning_content` (OpenRouter / some OpenAI
		// Responses API variants). When this branch fires we want a loud
		// warning so a gateway-normalization shift is surfaced early.
		if (fromMessage === undefined) {
			const rc = (msg as { reasoning_content?: unknown })
				.reasoning_content;
			if (typeof rc === "string" && rc.length > 0) {
				fromMessage = rc;
				console.warn(
					"[reasoning-trace] gateway emitted reasoning_content (not reasoning) on " +
						"choices[0].message — verify Vercel Gateway normalization.",
					{ textLength: rc.length },
				);
			}
		}
	}
	// Streaming converter shape: `choices[0].delta.reasoning` (accumulated
	// string-concat across all stream chunks via _mergeDicts).
	let fromDelta: string | undefined;
	const delta = (first as { delta?: unknown }).delta;
	if (delta && typeof delta === "object") {
		const r = (delta as { reasoning?: unknown }).reasoning;
		if (typeof r === "string" && r.length > 0) {
			fromDelta = r;
		}
		if (fromDelta === undefined) {
			const rc = (delta as { reasoning_content?: unknown })
				.reasoning_content;
			if (typeof rc === "string" && rc.length > 0) {
				fromDelta = rc;
				console.warn(
					"[reasoning-trace] gateway emitted reasoning_content (not reasoning) on " +
						"choices[0].delta — verify Vercel Gateway normalization.",
					{ textLength: rc.length },
				);
			}
		}
	}
	// Drift telemetry: when both shapes carry non-empty reasoning but they
	// disagree, that signals provider/library shape corruption or a future
	// LangChain converter change. Surface it to logs so we notice drift early;
	// still return the canonical `.message` value (the completed-message shape
	// is the more trusted source).
	if (
		fromMessage !== undefined &&
		fromDelta !== undefined &&
		fromMessage !== fromDelta
	) {
		console.warn(
			"[reasoning-trace] divergent reasoning text in __raw_response: " +
				"choices[0].message.reasoning != choices[0].delta.reasoning. " +
				"Returning .message value. Check LangChain converter version pin.",
			{
				messageLen: fromMessage.length,
				deltaLen: fromDelta.length,
			},
		);
	}
	if (fromMessage !== undefined) {
		return fromMessage;
	}
	if (fromDelta !== undefined) {
		return fromDelta;
	}
	return "";
}

/**
 * Extract `reasoning_tokens` (output token detail) from a LangChain
 * AIMessage's usage_metadata, if present. Returns 0 when unset. Used by
 * the billing-vs-text drift telemetry in {@link buildReasoningUpdate}.
 *
 * Shape (Vercel Gateway + LangChain core):
 *   usage_metadata?: {
 *     output_token_details?: { reasoning?: number };
 *   }
 *
 * @internal Exported for tests only.
 */
export function extractReasoningTokens(message: unknown): number {
	if (!message || typeof message !== "object") {
		return 0;
	}
	const usage = (message as { usage_metadata?: unknown }).usage_metadata;
	if (!usage || typeof usage !== "object") {
		return 0;
	}
	const details = (usage as { output_token_details?: unknown })
		.output_token_details;
	if (!details || typeof details !== "object") {
		return 0;
	}
	const r = (details as { reasoning?: unknown }).reasoning;
	return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : 0;
}
