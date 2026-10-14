/**
 * Pause and resume for bulk runs (Fizzy #2770). When every shared ChatGPT
 * plan the run may use is spent for longer than it should wait in place
 * (`ChatGptPlanPause` from `withChatGptPlanWait`), the workflow hands what it
 * finished to {@link pauseBulkRun} and ends: the run's row reads
 * WAITING_FOR_PLAN with `resumesAt`, and a resume run of the same workflow
 * type is scheduled for then with `resumeOf` on its input. The resume first
 * {@link claimBulkRunResume}s the row, then continues from the progress.
 *
 * A run pauses at most six times within 24 hours; past that the pause fails
 * with a message that says so. "Run now on API billing" starts the resume at
 * once with `allowApiFallback: true` on its input, which the client
 * interceptor turns into a header every activity of that run honours.
 *
 * Only reached behind `patched("bulk-pause-resume-v1")`: the pause itself is
 * thrown from `withChatGptPlanWait` only on that branch, and `resumeOf` is set
 * only on runs this code started.
 */

import type { BulkRunKind, BulkRunResumeOf } from "@repo/database";
import { ApplicationFailure } from "@temporalio/common";
import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type {
	claimBulkRunResumeActivity as ClaimFn,
	pauseBulkRunActivity as PauseFn,
} from "../../activities/bulk-run-pause";
import type { ChatGptPlanPause } from "./chatgpt-plan-wait";

const { pauseBulkRunActivity, claimBulkRunResumeActivity } = proxyActivities<{
	pauseBulkRunActivity: typeof PauseFn;
	claimBulkRunResumeActivity: typeof ClaimFn;
}>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

/** The fields a pausable run's input may carry beside its own. */
export interface BulkRunInputExtras {
	/** Set on a resume run: which run it continues. */
	resumeOf?: BulkRunResumeOf;
	/** Set on a resume a person started at once on API billing. */
	allowApiFallback?: boolean;
}

export const BULK_RUN_PAUSE_FAILED_TYPE = "BulkRunPauseFailed";

/**
 * A resume run takes its row back. `claimed: false` means a Cancel, the other
 * resume or the sweep got there first, and the run should end quietly.
 */
export async function claimBulkRunResume<P>(
	kind: BulkRunKind,
	input: BulkRunInputExtras & { resumeOf: BulkRunResumeOf },
): Promise<{ claimed: boolean; progress?: P }> {
	const claim = await claimBulkRunResumeActivity({
		kind,
		resumeOf: input.resumeOf,
		viaApiOverride: input.allowApiFallback === true,
	});
	return claim as { claimed: boolean; progress?: P };
}

/**
 * Saves the run's progress, marks it WAITING_FOR_PLAN and schedules its
 * resume. Throws a non-retryable failure with a readable message when the run
 * reached its pause cap or is no longer this run's to pause.
 */
export async function pauseBulkRun<I extends BulkRunInputExtras>(args: {
	kind: BulkRunKind;
	runId: string;
	/** The run's own input; `resumeOf` and `allowApiFallback` are dropped. */
	input: I;
	pause: ChatGptPlanPause;
	progress?: unknown;
	queuedDocumentIds?: string[];
}): Promise<{ resumesAt: string; pauseCount: number }> {
	const info = workflowInfo();
	const { resumeOf, allowApiFallback: _api, ...input } = args.input;
	const result = await pauseBulkRunActivity({
		kind: args.kind,
		runId: args.runId,
		pauseCount: resumeOf?.pauseCount ?? 0,
		workflowIdBase: resumeOf?.workflowIdBase ?? info.workflowId,
		workflowType: info.workflowType,
		taskQueue: info.taskQueue,
		...(info.executionTimeoutMs !== undefined && {
			executionTimeoutMs: info.executionTimeoutMs,
		}),
		input: input as Record<string, unknown>,
		...(args.progress !== undefined && { progress: args.progress }),
		waitMs: args.pause.waitMs,
		resetKnown: args.pause.resetKnown,
		...(args.queuedDocumentIds && {
			queuedDocumentIds: args.queuedDocumentIds,
		}),
	});
	if (!result.paused) {
		throw ApplicationFailure.nonRetryable(
			result.message,
			BULK_RUN_PAUSE_FAILED_TYPE,
		);
	}
	return { resumesAt: result.resumesAt, pauseCount: result.pauseCount };
}
