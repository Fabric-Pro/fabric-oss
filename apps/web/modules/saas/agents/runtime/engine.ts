import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import type { AuditRequestContext } from "@repo/api/lib/audit";
import type { Emit } from "./turn-translator";

/**
 * The authenticated person every runtime call acts for, bound per request
 * by the endpoint: the session's user, the organization the request was
 * tie-checked into, and the request's audit context (who, from where) for
 * the audit rows a stop writes.
 */
export interface RuntimeCaller {
	userId: string;
	organizationId: string;
	audit: AuditRequestContext;
}

/** One SSE response an engine writes a run (or a reconnect) into. */
export interface RunStream {
	emit: Emit;
	/** True once the client went away. The run itself is never cancelled for it. */
	isClosed: () => boolean;
	/**
	 * When this response stops tailing (epoch ms): the engine then sends
	 * `fabric.reconnect` and ends the response without a terminal event, and
	 * the client reconnects with `connect`.
	 */
	deadline: number;
}

/**
 * A chat engine behind the runtime (Direct, Orchestrator). Each call is
 * for the caller the runner was built with; a thread that is not the
 * caller's is refused by the engine as well as by the endpoint.
 */
export interface RuntimeEngine {
	/** This engine's stream window, when it differs from the runner's. */
	readonly streamWindowMs?: number;
	run(
		request: {
			threadId: string;
			input: RunAgentInput;
			/** The request's agent, for an engine that can run it in-process. */
			agent: AbstractAgent;
		},
		stream: RunStream,
	): Promise<void>;
	connect(threadId: string, stream: RunStream): Promise<void>;
	/** Whether this engine has a live turn on the thread. */
	isRunning(threadId: string): Promise<boolean>;
	/**
	 * Stop this engine's live turn on the thread (only the run `runId` names,
	 * when given). False when the thread has none of this engine's turns
	 * running.
	 */
	stop(threadId: string, runId?: string): Promise<boolean>;
}
