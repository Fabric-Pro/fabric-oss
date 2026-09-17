/**
 * The one way to hand a workflow-builder run to Temporal.
 *
 * Five surfaces start these runs — the manual oRPC procedure, the v1 REST
 * trigger, the webhook route, the MCP gateway tool and the Fabric AI chat
 * confirmation — and until this existed each spelled the start by hand. Two of
 * them got the workflow type wrong (`workflowExecutionWorkflow`,
 * `workflowBuilderExecution`: neither is registered, so Temporal accepted the
 * start and the run failed on its first task while the execution row sat at
 * PENDING forever), three disagreed on the workflow id scheme (so the cancel
 * paths that guessed the id addressed nothing), and only two set a run ceiling.
 *
 * Everything that has to agree lives here: the registered workflow type, the
 * id derived from the execution row, the queue, the ceiling, and the argument
 * shape the workflow actually reads.
 */

import { getTemporalClient } from "@repo/temporal";
import type { WorkflowBuilderExecutionInput } from "@repo/temporal/workflows";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	WORKFLOW_BUILDER_TASK_QUEUE,
	WORKFLOW_RUN_TIMEOUT,
} from "./execution-limits";

/**
 * The exported name of the workflow function in
 * `packages/temporal/src/workflows/workflow-builder-execution.ts`. Temporal
 * resolves workflow types by exported function name, so this string is the
 * contract; a typo here is a run that never starts, not a compile error.
 */
export const WORKFLOW_BUILDER_WORKFLOW_TYPE =
	"workflowBuilderExecutionWorkflow" as const;

/**
 * The Temporal workflow id for an execution row.
 *
 * Deterministic in the row id so a start is idempotent per execution (Temporal
 * rejects a duplicate id while the first run is open) and so a cancel can
 * address the run from the row alone, without a stored handle.
 */
export function builderWorkflowIdFor(executionId: string): string {
	return `workflow-execution-${executionId}`;
}

/**
 * What a caller has to supply. Identical to the workflow's own input; the
 * alias exists so callers depend on this module rather than on the workflow
 * bundle's type surface.
 */
export type StartWorkflowBuilderExecutionInput = WorkflowBuilderExecutionInput;

/**
 * Temporal rejects a second start for a workflow id whose execution is still
 * open. Because the id is derived from the execution row, hitting this means
 * an earlier attempt for this same row already started the workflow, so the
 * start is confirmed rather than failed. Matched by name: `@temporalio/client`
 * is not a direct dependency of this package.
 */
function isWorkflowAlreadyStartedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WorkflowExecutionAlreadyStartedError"
	);
}

/** Temporal's typed "no such execution" error, matched by name as above. */
function isWorkflowNotFoundError(error: unknown): boolean {
	return error instanceof Error && error.name === "WorkflowNotFoundError";
}

/**
 * What a caller learns from an attempt to start the run.
 *
 * - `confirmed`: the run exists in the engine. Either the start returned, or
 *   it threw and the deterministic id was found afterwards (`via` says which).
 *   Mark the row RUNNING; a failure to do so must not be reported as "not
 *   started".
 * - `not-started`: Temporal confirmed there is no execution under the id.
 *   Mark the row FAILED — nothing sweeps a PENDING execution — and say so.
 * - `unknown`: the start threw and the follow-up describe could not settle
 *   it either. The run may well be in progress under the deterministic id.
 *   Leave the row as it is (active) and report the uncertainty with the
 *   execution id so the caller polls rather than retries: a retry creates a
 *   NEW row, hence a new id, hence a second run with the same side effects.
 */
export type WorkflowBuilderStartOutcome =
	| {
			status: "confirmed";
			workflowId: string;
			runId?: string;
			via: "start" | "already-started" | "describe";
	  }
	| { status: "not-started"; workflowId: string; error: unknown }
	| { status: "unknown"; workflowId: string; error: unknown };

/**
 * Start the builder workflow for an execution row that already exists, and
 * settle what happened when the start call fails.
 *
 * Row creation stays with the caller: the trigger type, the recorded input
 * and the response shape differ per surface. This is the start and the
 * protocol around it — the same one the coding-run and Weave starters use.
 *
 * A start request can fail on the client (timeout, dropped connection) AFTER
 * the server has accepted it, so a generic start error does not say whether
 * an execution exists. Describing the deterministic workflow id settles it: a
 * description means the run exists, a typed `WorkflowNotFoundError` means the
 * start never happened, and any other failure leaves the question open.
 * Callers used to treat every throw as "never started" and fail the row; a
 * retry then created a fresh row and a fresh id, and the accepted-but-lost
 * run and the retry both ran.
 */
export async function attemptWorkflowBuilderStart(
	input: StartWorkflowBuilderExecutionInput,
): Promise<WorkflowBuilderStartOutcome> {
	const workflowId = builderWorkflowIdFor(input.executionId);

	let client: Awaited<ReturnType<typeof getTemporalClient>>;
	try {
		client = await getTemporalClient();
	} catch (error) {
		// No client, so no request left this process: nothing was started.
		return { status: "not-started", workflowId, error };
	}

	try {
		const handle = await client.workflow.start(
			WORKFLOW_BUILDER_WORKFLOW_TYPE,
			withCorrelationMemo({
				taskQueue: WORKFLOW_BUILDER_TASK_QUEUE,
				workflowId,
				// Node activities are capped at ten minutes each, but the walk
				// over them is otherwise unbounded, so a large or wedged graph
				// could hold a worker slot indefinitely. Temporal marks the run
				// TIMED_OUT, which the status enum already carries.
				workflowExecutionTimeout: WORKFLOW_RUN_TIMEOUT,
				args: [input],
			}),
		);
		return {
			status: "confirmed",
			workflowId: handle.workflowId,
			runId: handle.firstExecutionRunId,
			via: "start",
		};
	} catch (error) {
		if (isWorkflowAlreadyStartedError(error)) {
			return { status: "confirmed", workflowId, via: "already-started" };
		}

		try {
			const description = await client.workflow
				.getHandle(workflowId)
				.describe();
			return {
				status: "confirmed",
				workflowId,
				runId: description.runId,
				via: "describe",
			};
		} catch (describeError) {
			if (isWorkflowNotFoundError(describeError)) {
				return { status: "not-started", workflowId, error };
			}
			return { status: "unknown", workflowId, error };
		}
	}
}

/** The message a caller records or returns for a `not-started` outcome. */
export function startFailureMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Failed to start workflow";
}

/**
 * The message for an `unknown` outcome. Names the execution so the caller
 * polls it rather than retrying the start.
 */
export function unconfirmedStartMessage(executionId: string): string {
	return `The workflow engine did not confirm whether execution ${executionId} started. It may be running; check its status rather than starting it again.`;
}

/**
 * Request cancellation of the run behind an execution row.
 *
 * Throws if the run is already closed or never started. Callers treat that
 * as best-effort — they record the user's intent on the row regardless — so
 * they catch it rather than surface it.
 */
export async function cancelWorkflowBuilderExecution(
	executionId: string,
): Promise<void> {
	const client = await getTemporalClient();
	await client.workflow.getHandle(builderWorkflowIdFor(executionId)).cancel();
}
