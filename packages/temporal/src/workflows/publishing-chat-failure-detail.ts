import { ActivityFailure, TimeoutFailure } from "@temporalio/workflow";

/**
 * Extra log fields describing HOW the chat broadcast failed.
 *
 * Pure and deterministic, so it is safe inside a workflow, and separate from the
 * workflow so it can be tested without a `TestWorkflowEnvironment` and a log
 * sink. The workflow-side alternative would have been a case that drives a real
 * timeout and asserts on captured logs — more machinery than the mapping it
 * covers, and, worse, a case that would still pass if this mapping returned
 * nothing at all.
 *
 * WHY THE TIMEOUT CASE IS THE ONE THAT MATTERS. Every other failure reaches the
 * activity's own aggregate line (`publishing.chat.broadcast_complete`), which
 * carries the full counts. A timed-out activity is killed mid-run and never
 * reaches it, so the workflow's warning is the ONLY record — and on its own it
 * says a broadcast failed while giving no way to tell "reached nobody" from
 * "reached most of the room before the clock ran out". The activity heartbeats
 * `{done, total}` on every settled target precisely so this has something to
 * carry.
 */
export function publishingChatFailureDetail(error: unknown): {
	timeoutType?: unknown;
	progress?: unknown;
} {
	// `cause` rather than the ActivityFailure itself: Temporal wraps the real
	// reason, and `lastHeartbeatDetails` lives on the TimeoutFailure.
	if (
		error instanceof ActivityFailure &&
		error.cause instanceof TimeoutFailure
	) {
		return {
			timeoutType: error.cause.timeoutType,
			progress: error.cause.lastHeartbeatDetails,
		};
	}
	// Deliberately EMPTY rather than a placeholder. A non-timeout failure already
	// has the activity's own line with real counts on it; emitting `progress:
	// null` beside that would put a second, less informative number in an
	// operator's way and imply the run reported nothing.
	return {};
}
