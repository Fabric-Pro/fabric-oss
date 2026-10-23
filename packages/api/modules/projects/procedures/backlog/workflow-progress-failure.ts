import {
	BACKLOG_APPLY_USER_CANCEL_REASON,
	BACKLOG_APPLY_WATCHDOG_STOP_REASON,
} from "@repo/temporal";
import {
	ApplicationFailure,
	CancelledFailure,
	TerminatedFailure,
	WorkflowFailedError,
	type WorkflowHandle,
} from "@temporalio/client";

/** Require execution evidence before turning a failed read into a terminal outcome. */
export async function workflowProgressFailure(
	handle: WorkflowHandle,
	error: unknown,
	operation: "Apply" | "Analysis",
): Promise<{ status: "failed" | "cancelled"; message: string }> {
	const err = error as Error & { cause?: Error };
	let terminal = error instanceof WorkflowFailedError;
	let cancelled =
		terminal &&
		(err.cause instanceof CancelledFailure ||
			(err.cause instanceof ApplicationFailure &&
				err.cause.type ===
					(operation === "Apply"
						? "BACKLOG_APPLY_CANCELLED"
						: "BACKLOG_ANALYSIS_CANCELLED")));
	let message = err.cause?.message ?? err.message;
	let terminated = terminal && err.cause instanceof TerminatedFailure;
	let terminationReason = terminated ? err.cause?.message : undefined;
	try {
		const desc = await handle.describe();
		terminal ||= [
			"FAILED",
			"TERMINATED",
			"CANCELLED",
			"TIMED_OUT",
		].includes(desc.status.name);
		cancelled ||= desc.status.name === "CANCELLED";
		if (desc.status.name === "TERMINATED") {
			terminated = true;
			const history = await handle.fetchHistory();
			const terminationEvent = history.events?.find(
				(event) =>
					event.workflowExecutionTerminatedEventAttributes != null,
			);
			const reason =
				terminationEvent?.workflowExecutionTerminatedEventAttributes
					?.reason;
			if (reason) {
				terminationReason = reason;
				if (operation === "Analysis") {
					message = `Analysis terminated: ${reason}`;
				}
			}
		}
	} catch {
		// An SDK WorkflowFailedError remains evidence if describe/history is unavailable.
	}
	if (operation === "Apply" && terminated) {
		if (terminationReason === BACKLOG_APPLY_USER_CANCEL_REASON) {
			cancelled = true;
			message = "Apply cancelled.";
		} else if (terminationReason === BACKLOG_APPLY_WATCHDOG_STOP_REASON) {
			message =
				"Apply stopped because it stopped making progress. Open Review proposals to retry it.";
		} else {
			message = "Apply was stopped.";
		}
	}
	if (!terminal) {
		throw error;
	}
	return {
		status: cancelled ? "cancelled" : "failed",
		message: message ?? `${operation} failed`,
	};
}
