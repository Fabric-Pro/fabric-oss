/**
 * Names the activity behind a generic `ActivityFailure`. Runs in the workflow
 * sandbox — NEVER import `node:` modules or other Node-only code here.
 *
 * Once an activity gives up, the workflow receives an `ActivityFailure` whose
 * message is "Activity task failed" or "Activity task timed out". The
 * OpenTelemetry interceptor records only that message, so the exception that
 * reaches telemetry says neither which activity failed nor why (Fizzy #3461).
 * The activity's own logs cannot fill the gap for a timeout, which is decided
 * by the server after the worker has stopped hearing from it.
 *
 * The message leads with the activity type and the cause so the recurring-error
 * scan, which groups traces on their opening text, reports each failing
 * activity on its own instead of one group for all of them.
 */

import {
	ActivityFailure,
	type ActivityInput,
	ApplicationFailure,
	isCancellation,
	log,
	type Next,
	TimeoutFailure,
	type WorkflowInterceptors,
	type WorkflowOutboundCallsInterceptor,
} from "@temporalio/workflow";

const MAX_DETAIL_CHARS = 500;

function describeCause(cause: Error | undefined): string {
	if (cause instanceof ApplicationFailure) {
		return cause.type ?? cause.name;
	}
	if (cause instanceof TimeoutFailure) {
		return `${cause.name} ${cause.timeoutType}`;
	}
	return cause?.name ?? "UnknownCause";
}

function logActivityFailure(error: unknown): void {
	if (!(error instanceof ActivityFailure) || isCancellation(error)) {
		return;
	}
	try {
		const causeType = describeCause(error.cause);
		log.error(`Activity ${error.activityType} failed: ${causeType}`, {
			activityType: error.activityType,
			retryState: error.retryState,
			causeType,
			detail: error.cause?.message.slice(0, MAX_DETAIL_CHARS),
		});
	} catch {
		// Nothing awaits this branch, so an error thrown here would surface as
		// an unhandled rejection and fail a workflow task over a log line.
	}
}

class ActivityFailureLogInterceptor
	implements WorkflowOutboundCallsInterceptor
{
	scheduleActivity(
		input: ActivityInput,
		next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">,
	) {
		const result = next(input);
		// A side branch, not a wrapper: the caller gets `next`'s own promise, so
		// no continuation moves and recorded histories replay unchanged without
		// a `patched()` guard. The handler issues no command, and `log` writes
		// nothing while replaying.
		void result.then(undefined, logActivityFailure);
		return result;
	}
}

/**
 * Registered through `WORKFLOW_INTERCEPTOR_MODULES`, last, which puts it
 * closest to the SDK: the interceptors outside it await this same promise, so
 * its branch cannot hide a rejection that would otherwise go unhandled.
 */
export const interceptors = (): WorkflowInterceptors => ({
	outbound: [new ActivityFailureLogInterceptor()],
});
