/**
 * The durable AG-UI run's workflow contract: its id, queue, bounds and
 * input/result shapes (the Redis side is `agui-run-stream.ts`, which
 * re-exports this module for the web runtime).
 *
 * Import-free apart from the task-queue names, because the workflow bundle
 * imports it: nothing here may pull a Node or network module into the
 * workflow sandbox.
 */

/**
 * Where the workflow and its activity run: their own queue (see its comment
 * in `task-queues.ts`).
 */
export { AGUI_RUN_TASK_QUEUE } from "../task-queues";

/** The workflow type the web runtime starts. */
export const AGUI_RUN_WORKFLOW = "agUiAgentRunWorkflow";

/**
 * The lifetime of the AI token the run uses. The CopilotKit route mints it
 * for the request (its `AI_TOKEN_TTL_SECONDS`: `maxDuration` 800 s plus 100 s)
 * and hands it to the run through the input record, so this must equal the
 * route's value; a web test holds the two together.
 */
export const AGUI_RUN_TOKEN_TTL_SECONDS = 900;

/**
 * The most time between the route minting the token and the activity
 * starting: the rest of the request's setup, the workflow start and the web
 * runtime's pickup timeout (15 s), with room to spare. A run the worker has
 * not picked up by then was taken back into the request and terminated.
 */
export const AGUI_RUN_TOKEN_PICKUP_SLACK_SECONDS = 60;

/**
 * The longest one agent run may take on the worker (the activity's
 * start-to-close): the token's lifetime less the pickup slack, so the token
 * outlives every call the run makes.
 */
export const AGUI_RUN_MAX_DURATION_SECONDS =
	AGUI_RUN_TOKEN_TTL_SECONDS - AGUI_RUN_TOKEN_PICKUP_SLACK_SECONDS;

/**
 * The `RUN_ERROR` code the activity ends a run with when it failed before the
 * agent produced anything: the input record was gone, the worker lacks the
 * agent's credentials or address, or the agent's request failed before its
 * first event. Nothing ran, so the web runtime discards the run and runs the
 * turn in the request instead.
 */
export const AGUI_RUN_SETUP_FAILED_CODE = "AGUI_RUN_SETUP_FAILED";

/**
 * How long a run's events, and the thread record naming the run, stay
 * readable. Long enough for a reader who closed the tab mid-run to come back
 * the same working day and get the answer; by then the client has persisted
 * the run's messages into the conversation, which is the durable copy.
 */
export const AGUI_RUN_EVENT_RETENTION_SECONDS = 6 * 60 * 60;

/**
 * The upper bound on how long a run's input record (which holds the run's AI
 * token) stays in Redis. The activity takes it with an atomic read-and-delete
 * on pickup, normally seconds after it was written; a record nobody takes
 * expires instead of keeping a bearer token around.
 */
export const AGUI_RUN_INPUT_TTL_SECONDS = 30 * 60;

/** `agui-run-<runId>`: a retried AG-UI run id attaches to its workflow. */
export function agUiRunWorkflowId(runId: string): string {
	return `agui-run-${runId}`;
}

/**
 * The model the web route resolved for the caller, as the agents' `X-AI-*`
 * hints. Not secret: the provider key is reached through the AI token.
 */
export interface AgUiModelHints {
	model?: string;
	provider?: string;
	baseUrl?: string;
	deploymentName?: string;
	isReasoning?: boolean;
}

/**
 * The workflow's (and activity's) input. Carries no secret and no document:
 * the `RunAgentInput` and the request's AI token wait in Redis under
 * `inputRef`, so neither reaches the workflow's history.
 */
export interface AgUiAgentRunWorkflowInput {
	runId: string;
	threadId: string;
	/** The agent the run is for, as `agent-url-resolver` names it. */
	agentName: string;
	userId: string;
	organizationId: string;
	inputRef: string;
	modelHints: AgUiModelHints;
}

export type AgUiRunOutcome = "finished" | "error" | "cancelled";

export interface AgUiAgentRunResult {
	outcome: AgUiRunOutcome;
	/** Events appended to the run's stream, its terminal event included. */
	events: number;
}
