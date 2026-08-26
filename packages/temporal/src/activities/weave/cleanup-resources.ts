/**
 * Cleanup Weave Resources Activity
 *
 * Idempotent teardown of the Weave control-plane session, called from the
 * orchestrator and coding-run workflows inside a non-cancellable scope so
 * it fires on every exit path (success, failure, OAuth-block, cancel,
 * exception, timeout).
 *
 * Also reconciles the `WeaveExecution` row (and its parent `WeavePlan`)
 * for failure/cancel exits, so the database never shows a perpetual
 * "RUNNING" execution for a workflow that already died — including
 * init/sandbox failures that exit before a session ever existed.
 *
 * Also writes an audit-log entry per call so operators have a paper trail
 * for every Weave/CodingRun session that wound down through the happy
 * path, and can correlate against `weave.session.terminated_stale` rows
 * written by the watchdog cron for sessions that didn't.
 */

import { db, recordAudit } from "@repo/database";
import type { CodingRunProvider } from "@repo/database/prisma/generated/client";
import { log } from "@temporalio/activity";
import { getCodingExecutionProvider } from "../../lib/coding-execution/registry";

const NON_TERMINAL_EXECUTION_STATUSES = [
	"PENDING",
	"RUNNING",
	"PAUSED",
	"CHECKPOINT",
] as const;

export interface CleanupWeaveResourcesInput {
	/**
	 * Provider session id captured by the workflow when the sandbox was
	 * created. `null` means the workflow exited before a session existed —
	 * the activity returns a no-op success in that case.
	 */
	sessionId: string | null;
	/** Provider key — typically `"BACKGROUND_AGENTS"` or `"KANBAN_LOCAL"`. */
	provider: string;
	userId: string;
	organizationId: string | null;
	weaveExecutionId?: string | null;
	codingRunId?: string | null;
	exitReason:
		| "success"
		| "failure"
		| "cancelled"
		| "timeout"
		| "exception"
		| "oauth_blocked";
	/**
	 * Failure message captured by the workflow at the site that set
	 * `exitReason` — persisted onto `WeaveExecution.error` for
	 * failure/exception exits so the UI can show why the run died.
	 */
	errorMessage?: string | null;
	workflowId: string;
	runDurationMs: number;
}

export interface CleanupWeaveResourcesResult {
	destroyed: boolean;
	alreadyTerminal: boolean;
}

/**
 * Tear down the control-plane session, swallow expected errors (404 from
 * a provider that's already destroyed the session is treated as success),
 * and always record an audit entry so the lifecycle is observable.
 *
 * Before any teardown, reconcile the `WeaveExecution` row (and its parent
 * `WeavePlan`) for failure/cancel exits — this runs even when no session
 * was ever created (init/sandbox failures), which is exactly the case
 * that used to leave executions stuck in "RUNNING" forever.
 *
 * IMPORTANT: this activity intentionally does NOT rethrow on provider
 * failure. The workflow has already chosen its terminal state by the time
 * the finally block runs; throwing here would push the workflow into a
 * different state on the very last step. The same applies to the DB
 * reconciliation: a reconciliation failure is logged and swallowed, never
 * rethrown. The watchdog cron is the safety net for the rare case where
 * the provider call genuinely fails to clean up — those rows get
 * force-terminated after `WEAVE_MAX_RUN_MINUTES`.
 */
export async function cleanupWeaveResourcesActivity(
	input: CleanupWeaveResourcesInput,
): Promise<CleanupWeaveResourcesResult> {
	// Reconcile DB state FIRST — before the null-session early return.
	// The headline failure cases (init/sandbox failures) exit with no
	// session, and they must still flip the execution row to a terminal
	// status and un-wedge the parent plan.
	await reconcileWeaveExecutionState(input);

	if (!input.sessionId) {
		// Workflow exited before a session was created — there is nothing
		// to tear down. The audit row is still written so the lifecycle
		// is observable, but the outcome is "success" (a no-op success,
		// not a failure): reading "weave.session.terminated_on_exit /
		// outcome: failure" for this case was misleading — no teardown
		// actually failed, there was simply no session.
		writeTerminatedOnExitAudit(input, { outcome: "success" });
		return { destroyed: false, alreadyTerminal: true };
	}

	let destroyed = false;
	try {
		const provider = getCodingExecutionProvider(
			input.provider as CodingRunProvider,
		);
		await provider.cancelSession(input.sessionId);
		destroyed = true;
		log.info("weave_session_terminated_on_exit", {
			sessionId: input.sessionId,
			exitReason: input.exitReason,
			workflowId: input.workflowId,
			runDurationMs: input.runDurationMs,
			provider: input.provider,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/404|not.?found/i.test(message)) {
			// Provider already destroyed the session — treat as success.
			destroyed = true;
			log.info("weave_session_terminated_on_exit_already_gone", {
				sessionId: input.sessionId,
				workflowId: input.workflowId,
				provider: input.provider,
			});
		} else {
			log.warn("weave_session_termination_failed", {
				error: message,
				sessionId: input.sessionId,
				workflowId: input.workflowId,
				provider: input.provider,
			});
			// Intentionally swallow — see function docstring.
		}
	}

	writeTerminatedOnExitAudit(input, {
		outcome: destroyed ? "success" : "failure",
	});
	return { destroyed, alreadyTerminal: !destroyed };
}

/** Plan status to reconcile to, derived from the execution's final status. */
function planStatusForExecution(
	executionStatus: string,
): "COMPLETED" | "APPROVED" | null {
	if (executionStatus === "COMPLETED") {
		// A finished run leaves the plan COMPLETED.
		return "COMPLETED";
	}
	if (
		executionStatus === "CANCELLED" ||
		executionStatus === "FAILED" ||
		executionStatus === "TERMINATED_STALE"
	) {
		// A cancelled/failed run leaves the plan re-runnable.
		return "APPROVED";
	}
	// Still non-terminal (e.g. timeout, where the watchdog owns the
	// transition) — leave the plan as-is.
	return null;
}

/**
 * Persist the workflow's terminal outcome onto the `WeaveExecution` row and
 * move the parent `WeavePlan` off `RUNNING` so the plan stops looking live.
 *
 * The plan's status is set `RUNNING` when a run starts (`start-execution`)
 * and is otherwise managed ONLY here, so every terminal exit must move it
 * out of `RUNNING` — `COMPLETED` when the run finished, `APPROVED`
 * (re-runnable) when it was cancelled or failed. Crucially the plan is
 * reconciled from the execution's ACTUAL final status, not the workflow's
 * `exitReason`: a cancelled run whose execution phase reported `success`
 * (e.g. a Shuttle that was cancelled before producing a PR) would otherwise
 * leave the plan wedged in `RUNNING` forever.
 *
 * Execution-status handling by exit reason:
 * - `failure` / `exception` → execution `FAILED` (+ error message) when the
 *   row is still non-terminal.
 * - `cancelled` → execution `CANCELLED` when still non-terminal (the cancel
 *   procedure usually set it already; the guard makes this a no-op).
 * - `timeout` → no execution-row change. The watchdog owns the timeout
 *   path (it calls this immediately before `markWeaveExecutionStale`), and
 *   the plan reconcile below also no-ops because the row is still RUNNING.
 * - `success` / `oauth_blocked` → no execution-row change (the completion
 *   phase persisted the terminal state; the execution-status guard prevents
 *   it overwriting a cancelled run).
 *
 * All writes are guarded `updateMany`s so already-terminal rows are never
 * overwritten. Errors are logged and swallowed — the watchdog and the
 * read-path reconcile remain safety nets.
 */
async function reconcileWeaveExecutionState(
	input: CleanupWeaveResourcesInput,
): Promise<void> {
	if (!input.weaveExecutionId) {
		// Coding-run callers don't own a WeaveExecution row.
		return;
	}

	try {
		// 1. Persist a terminal status from the workflow's exit reason when
		//    the row is still non-terminal (a failed/cancelled workflow that
		//    didn't already record one).
		const isFailureExit =
			input.exitReason === "failure" || input.exitReason === "exception";
		const isCancelledExit = input.exitReason === "cancelled";
		if (isFailureExit || isCancelledExit) {
			await db.weaveExecution.updateMany({
				where: {
					id: input.weaveExecutionId,
					status: {
						in: NON_TERMINAL_EXECUTION_STATUSES as unknown as never[],
					},
				},
				data: isFailureExit
					? {
							status: "FAILED",
							error:
								input.errorMessage ??
								`Execution failed (${input.exitReason})`,
							completedAt: new Date(),
						}
					: {
							status: "CANCELLED",
							completedAt: new Date(),
						},
			});
		}

		// 2. Reconcile the parent plan to the execution's FINAL status. Read
		//    the row back so this reflects whatever terminal state was set —
		//    by step 1 above, by the cancel procedure, or by the completion
		//    phase — rather than the workflow's exit reason.
		const execution = await db.weaveExecution.findUnique({
			where: { id: input.weaveExecutionId },
			select: { status: true, planId: true },
		});
		if (execution) {
			const planStatus = planStatusForExecution(execution.status);
			if (planStatus) {
				await db.weavePlan.updateMany({
					where: { id: execution.planId, status: "RUNNING" },
					data: { status: planStatus },
				});
			}
		}
	} catch (err) {
		log.warn("weave_execution_reconciliation_failed", {
			error: err instanceof Error ? err.message : String(err),
			weaveExecutionId: input.weaveExecutionId,
			exitReason: input.exitReason,
			workflowId: input.workflowId,
		});
		// Intentionally swallow — see function docstring.
	}
}

function writeTerminatedOnExitAudit(
	input: CleanupWeaveResourcesInput,
	{ outcome }: { outcome: "success" | "failure" },
): void {
	recordAudit({
		action: "weave.session.terminated_on_exit",
		category: "weave",
		severity: "info",
		outcome,
		actor: { type: "system", nameSnapshot: "temporal-worker" },
		organizationId: input.organizationId,
		resource: input.weaveExecutionId
			? { type: "weave_execution", id: input.weaveExecutionId }
			: input.codingRunId
				? { type: "coding_run", id: input.codingRunId }
				: undefined,
		metadata: {
			sessionId: input.sessionId,
			exitReason: input.exitReason,
			workflowId: input.workflowId,
			runDurationMs: input.runDurationMs,
			provider: input.provider,
		},
	});
}
