/**
 * The Orchestrator chat over the agent runtime: the names and shapes its
 * server engine (`modules/saas/agents/runtime/orchestrator-*.ts`) and its
 * browser transport (`useOrchestratorRuntimeStream`) agree on. Each AG-UI
 * event carries one stream-route event (`orchestrator-stream-protocol.ts`),
 * so the chat applies both transports' events with the same reducer.
 *
 * | Stream-route event                | AG-UI event                                                               |
 * |-----------------------------------|---------------------------------------------------------------------------|
 * | `started`                         | RUN_STARTED, STATE_SNAPSHOT, CUSTOM `fabric.execution` `{executionId, turnId, turnGeneration, resumed}` |
 * | `text_start`                      | closes the open text segment (TEXT_MESSAGE_END)                           |
 * | `text_delta`                      | TEXT_MESSAGE_CONTENT, after a TEXT_MESSAGE_START when no segment is open. A segment opens after `text_start` and on a response's first text, and the client reads its START as `text_start` (the next text replaces the answer's) |
 * | `tool_start` / `tool_input` / `tool_result` | TOOL_CALL_START / TOOL_CALL_ARGS (the whole arguments as JSON, a replacement) / TOOL_CALL_END + TOOL_CALL_RESULT; `metadata.fabric` = the event's other fields |
 * | `phase`, `routing`, `planning`, `step_start`, `progress` | STATE_DELTA `replace` at `/phase`, `/routing`, `/plan`, `/currentStep`, `/progress` (value = the event's fields) |
 * | `step_complete`, `limit_signal`, `context_compacted`, `mcp_default_tool_*`, `approval_resolved`, `clarifying_resolved`, a tool event without an id | CUSTOM `fabric.orchestrator.event` (value = the whole event) |
 * | `approval_required` / `clarifying_question` | RUN_FINISHED outcome `interrupt` (reason `orchestrator_approval` / `orchestrator_clarification`, `metadata.fabric` = the event) |
 * | `completed`                       | RUN_FINISHED outcome `success` (`cancelled` for a stopped turn), `result` = the event's fields |
 * | `error`                           | RUN_ERROR, `metadata.fabric` = the whole event (a refused run's `metadata.fabric` is the refusal's body, never an event) |
 * | `stream_timeout`                  | CUSTOM `fabric.reconnect`: the response ended, the turn did not          |
 * | `: ping` (every 15 s)             | CUSTOM `fabric.heartbeat` after 15 s with nothing else sent              |
 * | billing header                    | CUSTOM `fabric.billing`                                                   |
 */

/** The runtime agent id the Orchestrator engine serves. */
export const ORCHESTRATOR_AGENT_ID = "fabric-orchestrator";

/** The `CUSTOM` event names an Orchestrator run carries. */
export const ORCHESTRATOR_RUN_EVENT = {
	/** The turn's workflow and turn ids, as the stream route's `started`. */
	execution: "fabric.execution",
	/** The stream route's API-billing header. */
	billing: "fabric.billing",
	/** The response's window ended; the turn did not. Reconnect with `connect`. */
	reconnect: "fabric.reconnect",
	/** Sent when a response was otherwise quiet for 15 s: the connection is alive. */
	heartbeat: "fabric.heartbeat",
	/** A stream-route event with no AG-UI counterpart, carried whole. */
	event: "fabric.orchestrator.event",
	/** A follow-up reached the running turn as a signal. */
	followUp: "fabric.orchestrator.follow-up",
	/** The interrupt a resume answered is no longer pending; nothing was decided. */
	interruptStale: "fabric.orchestrator.interrupt-stale",
} as const;

/** The interrupt reasons an Orchestrator run stops with. */
export const ORCHESTRATOR_INTERRUPT_REASON = {
	approval: "orchestrator_approval",
	clarification: "orchestrator_clarification",
} as const;

/** The agent-state paths an Orchestrator run replaces, by stream-route event. */
export const ORCHESTRATOR_STATE_PATH = {
	phase: "/phase",
	routing: "/routing",
	planning: "/plan",
	step_start: "/currentStep",
	progress: "/progress",
} as const;

/** The run's agent state when a response starts (`STATE_SNAPSHOT`). */
export interface OrchestratorRunState {
	executionId: string;
	turnId: string;
	turnGeneration: number | null;
	phase: unknown;
	routing: unknown;
	plan: unknown;
	currentStep: unknown;
	progress: unknown;
}

/**
 * The ids a turn's messages are saved under, derived from the turn's key so
 * a retried save fills the same slots.
 */
export function orchestratorTurnMessageIds(turnKey: string) {
	return {
		user: `${turnKey}:user`,
		assistant: `${turnKey}:assistant`,
		clarification: (clarificationId: string) =>
			`${turnKey}:clarification:${clarificationId}`,
	};
}

/** The prefix of a turn's clarification message ids. */
export function orchestratorClarificationIdPrefix(turnKey: string): string {
	return `${turnKey}:clarification:`;
}
