/**
 * MCP Default-Tool Telemetry Publisher
 *
 * Activity-side bridge between the workflow's accumulated
 * `state.mcpDefaultToolSignals` payloads and the SSE stream the client
 * hooks consume. The workflow itself cannot publish to Redis directly —
 * `publishExecutionEvent` is a side-effecting I/O call and must live in
 * an activity for Temporal replay determinism. This module wraps the
 * shared `redis-publisher` so the workflow can fire one event per signal
 * via `proxyActivities` without re-implementing the channel naming or
 * the fire-and-forget error semantics.
 *
 * Channel: `execution:{executionId}`.
 *
 * Event names on the Redis channel:
 *   - `execution.mcp_default_tool_invoked`
 *   - `execution.mcp_default_tool_failed`
 *
 * The SSE route forwards each as a plain SSE event named without the
 * `execution.` prefix so the client switch reads `event.type ===
 * "mcp_default_tool_invoked"` / `"mcp_default_tool_failed"`.
 *
 * Payload shapes are owned by
 * `packages/temporal/src/workflows/orchestrator/types/mcp-default-tool-signal.types.ts`.
 * The activity does NOT sanitize `errorMessage` — that is the caller's
 * responsibility (the activity is too far downstream to re-sanitize
 * without doubling the work, and we want a single canonical sanitize
 * point at the failure-emission call site so it shows up next to the
 * failure classification logic).
 */

import { publishExecutionEvent } from "../../../lib/redis-publisher";
import type {
	McpDefaultToolFailedPayload,
	McpDefaultToolInvokedPayload,
	McpDefaultToolSignal,
} from "../../../workflows/orchestrator/types/mcp-default-tool-signal.types";

/**
 * Strip the `kind` discriminator so the SSE payload mirrors the
 * analytics envelope exactly (`surface`, `serverKey`, `toolName`,
 * `configSource`, `executionId`, `organizationId` — no `kind` field).
 */
function stripKind<T extends { kind: string }>(payload: T): Omit<T, "kind"> {
	const { kind: _kind, ...rest } = payload;
	void _kind;
	return rest;
}

/**
 * Publish a single managed-default MCP tool signal as an execution event
 * over the Redis pub/sub channel. Fire-and-forget — Redis outages do NOT
 * propagate (the underlying `publishExecutionEvent` swallows them) so
 * the orchestrator iteration is never blocked on analytics infra.
 *
 * Invoked from the workflow via `proxyActivities`; each call publishes
 * exactly one event. Workflow callers iterate over
 * `state.mcpDefaultToolSignals` and invoke this once per new entry.
 */
export async function publishMcpDefaultToolSignalActivity(
	executionId: string,
	signal: McpDefaultToolSignal,
): Promise<void> {
	const event =
		signal.kind === "invoked"
			? "execution.mcp_default_tool_invoked"
			: "execution.mcp_default_tool_failed";

	// `Record<string, unknown>` is the contract `ExecutionEvent.data`
	// expects. `stripKind` returns a structurally-identical object minus
	// the discriminator so the SSE consumer sees the exact analytics
	// payload shape.
	const data = stripKind(signal) as unknown as Record<string, unknown>;

	await publishExecutionEvent(executionId, {
		event,
		data,
	});
}

// Re-export the payload types for callers that proxy this activity —
// keeps the import surface tight (callers don't have to dig through the
// workflow types module separately).
export type {
	McpDefaultToolFailedPayload,
	McpDefaultToolInvokedPayload,
	McpDefaultToolSignal,
};
