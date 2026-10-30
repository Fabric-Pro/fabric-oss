/**
 * One agent's answer in a multi-agent turn, as Nexus (`useMultiAgentStream`)
 * and the Orchestrator chat's multi-agent mode both build it: its text, its
 * tool calls merged as they stream, and its approval. Rendered by
 * `AgentResponseBlock`.
 */

export interface MultiAgentToolCall {
	id: string;
	name: string;
	args: unknown;
	result?: unknown;
	serverName?: string;
	status: "pending" | "running" | "complete" | "error" | "success";
	/** MCP App: ui:// resource URI for the interactive HTML UI */
	mcpAppResourceUri?: string;
	/** MCP App: config ID for proxying tool calls back to the MCP server */
	mcpAppConfigId?: string;
}

export interface AgentResponse {
	agentId: string;
	agentName: string;
	/** vendor name for model agents — used to show provider logo */
	vendor?: string;
	executionId?: string;
	content: string;
	toolCalls: MultiAgentToolCall[];
	isLoading: boolean;
	isError: boolean;
	errorMessage?: string;
	/**
	 * Per-agent stream lifecycle status.
	 * `"cancelled"` is set by `stopAll` only on agents that were
	 * still in-flight at click-time. Already-`"completed"` agents in
	 * the same turn keep their status — they are not retroactively
	 * relabelled (decision 18 /).
	 * `extractResumableExecutions` in `CopilotPage.tsx` filters by
	 * `status === "streaming"` so cancelled agents are implicitly
	 * non-resumable on next page reload (/ decision 14).
	 */
	status: "idle" | "streaming" | "completed" | "error" | "cancelled";
	/** ISO timestamp stamped when this agent was cancelled. */
	cancelledAt?: string;
	/** Set when the orchestrator is waiting for user approval before proceeding */
	pendingApproval?: {
		approvalId: string;
		stepId: string;
		reason: string;
	} | null;
}

/**
 * The orchestrator's `buildWorkflowOutput` truncates oversized tool call
 * args/results to a sentinel string before returning the workflow output.
 * That sentinel can arrive on the `completed`/`step_complete` events
 * AFTER the live `tool_input`/`tool_result` events have already populated
 * the full payload. If we let it overwrite the live data, MCP App
 * iframes (e.g. Excalidraw) re-sync the truncated string to their bridge
 * and the canvas blanks. Reject the sentinel here as defense-in-depth —
 * the cap bump in `completion.ts` is the primary fix.
 */
function isTruncatedSentinel(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("[Object truncated,");
}

export function mergeToolCall(
	existingToolCalls: MultiAgentToolCall[],
	incoming: MultiAgentToolCall,
): MultiAgentToolCall[] {
	const existingIndex = existingToolCalls.findIndex(
		(tc) => tc.id === incoming.id || tc.name === incoming.name,
	);

	if (existingIndex < 0) {
		return [...existingToolCalls, incoming];
	}

	return existingToolCalls.map((tc, index) =>
		index === existingIndex
			? {
					...tc,
					...incoming,
					args: isTruncatedSentinel(incoming.args)
						? tc.args
						: (incoming.args ?? tc.args),
					result: isTruncatedSentinel(incoming.result)
						? tc.result
						: (incoming.result ?? tc.result),
					status:
						tc.status === "complete" ? tc.status : incoming.status,
					mcpAppResourceUri:
						incoming.mcpAppResourceUri ?? tc.mcpAppResourceUri,
					mcpAppConfigId:
						incoming.mcpAppConfigId ?? tc.mcpAppConfigId,
				}
			: tc,
	);
}

export function mergeStreamedText(
	currentContent: string,
	incomingContent: unknown,
): string {
	if (typeof incomingContent !== "string" || incomingContent.length === 0) {
		return currentContent;
	}

	if (!currentContent) {
		return incomingContent;
	}

	if (incomingContent === currentContent) {
		return currentContent;
	}

	if (incomingContent.startsWith(currentContent)) {
		return incomingContent;
	}

	if (currentContent.startsWith(incomingContent)) {
		return currentContent;
	}

	const overlapLimit = Math.min(
		currentContent.length,
		incomingContent.length,
	);
	for (let overlap = overlapLimit; overlap > 0; overlap--) {
		if (
			currentContent.slice(-overlap) === incomingContent.slice(0, overlap)
		) {
			return currentContent + incomingContent.slice(overlap);
		}
	}

	return currentContent.length >= incomingContent.length
		? currentContent
		: incomingContent;
}

/**
 * The next text run of an answer after a tool interrupted it: a paragraph
 * break before it, so sentences either side of the tool do not run together.
 */
export function withTextBreak(content: string, delta: string): string {
	return content && !/\s$/.test(content) && !/^\s/.test(delta)
		? `\n\n${delta}`
		: delta;
}
