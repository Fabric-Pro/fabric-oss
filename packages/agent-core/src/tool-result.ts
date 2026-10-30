/**
 * Detect a ToolMessage across the three on-the-wire formats LangGraph
 * may deserialize state into. Mirrors `isHumanMessage` in
 * `chat-node-reasoning.ts` — we cannot use `m instanceof ToolMessage`
 * because class identity is lost when state crosses the graph boundary.
 */
export function isToolMessage(m: unknown): m is {
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
