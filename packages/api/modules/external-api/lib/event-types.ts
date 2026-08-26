/**
 * Execution Stream Event Types
 *
 * Defines all SSE events emitted during agent execution streaming.
 * Events come from two sources:
 * - Temporal queries: phase transitions, status updates
 * - Redis pub/sub: real-time token deltas, tool call completions
 */

/**
 * All possible SSE event types.
 *
 * Workflow events may include additional fields (e.g. goal-oriented workflows
 * emit `execution.iteration`, `execution.verification`) — the `data` field
 * is kept as `Record<string, unknown>` for extensibility.  The named unions
 * below document the *common* shapes; clients should be tolerant of extra keys.
 */
export type ExecutionStreamEvent =
	// Workflow-level events (from Temporal queries)
	| { event: "execution.started"; data: Record<string, unknown> }
	| {
			event: "execution.phase_changed";
			data: { phase: string; message: string; [k: string]: unknown };
	  }
	| {
			event: "execution.knowledge_completed";
			data: {
				totalChunks: number;
				sourcesFetched: number;
				[k: string]: unknown;
			};
	  }
	| {
			event: "execution.tool_calls_summary";
			data: {
				toolCalls: Array<{
					name: string;
					status: string;
					durationMs?: number;
				}>;
				[k: string]: unknown;
			};
	  }
	| {
			event: "execution.plan_created";
			data: Record<string, unknown>;
	  }
	| {
			event: "execution.step_started";
			data: Record<string, unknown>;
	  }
	| {
			event: "execution.step_completed";
			data: Record<string, unknown>;
	  }
	| {
			event: "execution.iteration";
			data: {
				iteration: number;
				maxIterations: number;
				[k: string]: unknown;
			};
	  }
	| {
			event: "execution.verification";
			data: {
				achieved: boolean;
				confidence: number;
				[k: string]: unknown;
			};
	  }
	| {
			event: "execution.completed";
			data: {
				output?: unknown;
				durationMs: number;
				[k: string]: unknown;
			};
	  }
	| {
			event: "execution.failed";
			data: { error: string; durationMs: number; [k: string]: unknown };
	  }
	| {
			event: "execution.cancelled";
			data: { reason: string; [k: string]: unknown };
	  }
	// Real-time events (from Redis pub/sub)
	| { event: "execution.text_delta"; data: { text: string } }
	| {
			event: "execution.tool_call_completed";
			data: { toolName: string; toolCallId: string; status: string };
	  }
	// Artifact events
	| {
			event: "execution.artifact_created";
			data: {
				artifactId: string;
				name: string;
				mimeType: string;
			};
	  };

/**
 * Format an event as an SSE string.
 */
export function formatSSE(event: ExecutionStreamEvent): string {
	return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
