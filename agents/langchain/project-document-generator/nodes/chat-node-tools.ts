import type { BaseMessage } from "@langchain/core/messages";

/**
 * Per-turn tool-call trace entry. See state/index.ts `toolCallsByTurn`
 * Annotation for the lifecycle (pending → success/error reconciliation).
 */
export interface ToolCallTrace {
	id: string;
	name: string;
	status: "pending" | "success" | "error";
	startedAt: number;
	durationMs?: number;
	errorMessage?: string;
}

/**
 * Minimal shape of a tool-call entry on an AIMessage produced by LangChain.
 * Anthropic + OpenAI both materialize tool calls into this normalized
 * `tool_calls: [{ id, name, args }]` array via the AIMessage's
 * `lc_kwargs`/getter — we read it from the typed response.
 */
interface AIToolCallLike {
	id?: string;
	name?: string;
}

/**
 * Detect a ToolMessage across the three on-the-wire formats LangGraph
 * may deserialize state into. Mirrors `isHumanMessage` in
 * `chat-node-reasoning.ts` — we cannot use `m instanceof ToolMessage`
 * because class identity is lost when state crosses the graph boundary.
 */
function isToolMessage(m: unknown): m is {
	tool_call_id?: string;
	status?: string;
	content?: unknown;
	additional_kwargs?: Record<string, unknown>;
} {
	if (!m || typeof m !== "object") {
		return false;
	}
	const obj = m as {
		_getType?: () => string;
		type?: string;
		role?: string;
	};
	if (typeof obj._getType === "function") {
		return obj._getType() === "tool";
	}
	if (obj.type === "tool") {
		return true;
	}
	if (obj.role === "tool") {
		return true;
	}
	return false;
}

/**
 * Determine whether a ToolMessage represents a failed tool execution.
 *
 * Recognises LangChain's first-class `status: "error"` field
 * (`@langchain/core` ≥ 0.3 sets this when a tool throws) and the older
 * `additional_kwargs.status` shape used by some adapters. Falls back to
 * heuristic content sniffing ("Error:" prefix) as a last resort so
 * pre-status-field tool runtimes still surface red status correctly.
 */
export function isToolResultError(toolMsg: unknown): boolean {
	if (!isToolMessage(toolMsg)) {
		return false;
	}
	if (toolMsg.status === "error") {
		return true;
	}
	const kw = toolMsg.additional_kwargs;
	if (
		kw &&
		typeof kw === "object" &&
		(kw as { status?: unknown }).status === "error"
	) {
		return true;
	}
	const content = toolMsg.content;
	if (typeof content === "string") {
		const trimmed = content.trimStart();
		if (trimmed.startsWith("Error:") || trimmed.startsWith("Error ")) {
			return true;
		}
	}
	return false;
}

/**
 * Extract a short error message from an errored ToolMessage. Returns
 * undefined for non-errors. The string is intended for inline UI display
 * (tooltip / collapsed row), so we cap length to avoid bloating
 * STATE_SNAPSHOT events with arbitrary stack traces.
 */
export function extractErrorMessage(toolMsg: unknown): string | undefined {
	if (!isToolResultError(toolMsg)) {
		return undefined;
	}
	if (!isToolMessage(toolMsg)) {
		return undefined;
	}
	const content = toolMsg.content;
	let raw: string | undefined;
	if (typeof content === "string") {
		raw = content;
	} else if (Array.isArray(content)) {
		// Anthropic-style multi-block content: concatenate text blocks.
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
		raw = acc;
	}
	if (!raw) {
		return undefined;
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	// Cap at 240 chars to keep STATE_SNAPSHOT payload small.
	return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

/**
 * Reconcile per-turn tool-call traces with the latest chat-node response.
 *
 * Algorithm:
 *  1. For every existing `pending` entry, look up a ToolMessage in
 *     `messages` whose `tool_call_id` matches `entry.id`. If found,
 *     transition to `success` or `error` with `durationMs` and (on
 *     errors) `errorMessage`.
 *  2. For every `tool_call` on the freshly-returned AIMessage, append a
 *     new `pending` entry — unless the id already exists in `existing`
 *     (defensive dedup; the model occasionally re-emits the same id on
 *     retries, in which case we keep the existing entry untouched).
 *
 * Pure function: returns a new array, never mutates `existing`.
 */
export function reconcileToolCalls(
	existing: ToolCallTrace[] | undefined,
	messages: BaseMessage[],
	newAIToolCalls: AIToolCallLike[] | undefined,
	now: number,
): ToolCallTrace[] {
	const prev = existing ?? [];
	const updated: ToolCallTrace[] = prev.map((entry) => {
		if (entry.status !== "pending") {
			return entry;
		}
		if (!entry.id) {
			return entry;
		}
		const toolMsg = messages.find((m) => {
			if (!isToolMessage(m)) {
				return false;
			}
			return m.tool_call_id === entry.id;
		});
		if (!toolMsg) {
			return entry;
		}
		const isError = isToolResultError(toolMsg);
		const next: ToolCallTrace = {
			...entry,
			status: isError ? "error" : "success",
			durationMs: Math.max(0, now - entry.startedAt),
		};
		if (isError) {
			const msg = extractErrorMessage(toolMsg);
			if (msg) {
				next.errorMessage = msg;
			}
		}
		return next;
	});

	if (newAIToolCalls && newAIToolCalls.length > 0) {
		const knownIds = new Set(updated.map((e) => e.id));
		for (const tc of newAIToolCalls) {
			if (!tc.id || !tc.name) {
				continue;
			}
			if (knownIds.has(tc.id)) {
				continue;
			}
			updated.push({
				id: tc.id,
				name: tc.name,
				status: "pending",
				startedAt: now,
			});
			knownIds.add(tc.id);
		}
	}

	return updated;
}
