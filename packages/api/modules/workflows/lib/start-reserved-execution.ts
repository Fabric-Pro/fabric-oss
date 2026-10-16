/**
 * Handing a reserved execution row to the engine and recording what happened:
 * the one "start, then record" step behind every trigger surface (the in-app
 * Run button, the Fabric Agent's tools, the webhook and the public API).
 *
 * The surfaces differ in how the row is reserved (an idempotency key, the
 * workflow's owner, an API key's scope) and in how an outcome is shown (an
 * oRPC result, a status code and body). They must not differ in what each
 * outcome of the start means for the row, which is what this settles once:
 *
 * - confirmed: the run exists in the engine. Mark the row RUNNING, and if that
 *   write fails keep reporting the start; a retry would run it twice.
 * - unconfirmed: the start call failed and could not be settled. The run may be
 *   in progress, so the row stays active and keeps its idempotency key.
 * - failed: nothing runs and nothing will. No sweeper reclaims a PENDING row,
 *   so it is marked FAILED, and releases its idempotency key in the same write.
 *
 * The reservation itself stays with the caller (`execution-concurrency.ts`).
 */

import {
	db,
	markExecutionRunningIfPending,
	releasedIdempotencyTriggerInput,
	type WorkflowExecution,
} from "@repo/database";
import {
	attemptWorkflowBuilderStart,
	type StartWorkflowBuilderExecutionInput,
	startFailureMessage,
	unconfirmedStartMessage,
} from "./start-builder-execution";

export const ENGINE_UNAVAILABLE_MESSAGE =
	"Workflow engine unavailable — the run was not started. Try again.";

export type ReservedExecutionStart =
	| {
			status: "started";
			temporalWorkflowId: string;
			/**
			 * The row had already moved past PENDING when it was marked: a short
			 * run finished first, and the row says where it is.
			 */
			rowAlreadyAdvanced: boolean;
	  }
	| {
			status: "unconfirmed";
			temporalWorkflowId: string;
			message: string;
	  }
	| {
			status: "failed";
			failure: "engine-unavailable" | "start-rejected";
			message: string;
	  };

export async function startReservedExecution(input: {
	execution: WorkflowExecution;
	start: Omit<StartWorkflowBuilderExecutionInput, "executionId">;
	/** Names the surface in log lines. */
	logTag: string;
}): Promise<ReservedExecutionStart> {
	const { execution, logTag } = input;
	const outcome = await attemptWorkflowBuilderStart({
		...input.start,
		executionId: execution.id,
	});

	if (outcome.status === "confirmed") {
		// PENDING → RUNNING only: a fast run may already have written its
		// terminal status, which must not move back.
		let rowAlreadyAdvanced = false;
		try {
			rowAlreadyAdvanced = !(await markExecutionRunningIfPending({
				executionId: execution.id,
				temporalRunId: outcome.workflowId,
			}));
		} catch (error) {
			console.error(
				`[${logTag}] Run started but the execution row could not be marked RUNNING:`,
				{ executionId: execution.id, workflowId: outcome.workflowId },
				error,
			);
		}
		return {
			status: "started",
			temporalWorkflowId: outcome.workflowId,
			rowAlreadyAdvanced,
		};
	}

	if (outcome.status === "unknown") {
		console.warn(
			`[${logTag}] Start unconfirmed; leaving the execution row active:`,
			{ executionId: execution.id, workflowId: outcome.workflowId },
			outcome.error,
		);
		return {
			status: "unconfirmed",
			temporalWorkflowId: outcome.workflowId,
			message: unconfirmedStartMessage(execution.id),
		};
	}

	console.error(`[${logTag}] Failed to start the workflow:`, outcome.error);
	const message =
		outcome.cause === "engine-unavailable"
			? ENGINE_UNAVAILABLE_MESSAGE
			: `The workflow engine rejected the start: ${startFailureMessage(outcome.error)}`;
	const failedAt = new Date();
	const releasedTriggerInput = releasedIdempotencyTriggerInput(
		execution.triggerInput,
	);
	await db.workflowExecution.update({
		where: { id: execution.id },
		data: {
			status: "FAILED",
			error: message,
			completedAt: failedAt,
			duration: failedAt.getTime() - execution.startedAt.getTime(),
			...(releasedTriggerInput
				? { triggerInput: releasedTriggerInput }
				: {}),
		},
	});
	return { status: "failed", failure: outcome.cause, message };
}
