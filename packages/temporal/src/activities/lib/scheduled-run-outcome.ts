/**
 * What counting one scheduled run does to a workflow's {@link ScheduledRunState}.
 * Pure, so the rules (a success resets the streak, the third failure in a row
 * pauses, a resumed workflow starts clean) are tested without a database; the
 * activity applies the decision inside the transaction.
 */

import type { ScheduledRunState } from "./workflow-settings";

/** Consecutive failed scheduled runs after which an unattended workflow pauses itself. */
export const PAUSE_AFTER_CONSECUTIVE_FAILURES = 3;

/** `pausedReason` of a workflow paused because its owner may no longer run it. */
export const OWNER_ACCESS_LOST_REASON = "owner-access-lost";

export type ScheduledRunStatus = "COMPLETED" | "FAILED" | "CANCELLED";

export interface ScheduledRunOutcomeDecision {
	/** What to store; the execution id is already recorded as the last counted. */
	state: ScheduledRunState;
	/** This success is the workflow's first, so its owner is told. */
	firstSuccess: boolean;
	/** This failure reached the limit on a live workflow, so it pauses now. */
	pause: boolean;
}

/** The state of a workflow that has just paused itself, for `reason`. */
export function pausedState(
	state: ScheduledRunState,
	reason: string,
	now: string,
): ScheduledRunState {
	return { ...state, pausedAt: now, pausedReason: reason };
}

export function decideScheduledRunOutcome(input: {
	state: ScheduledRunState;
	executionId: string;
	status: ScheduledRunStatus;
	workflowIsLive: boolean;
	workflowIsPaused: boolean;
	now: string;
}): ScheduledRunOutcomeDecision {
	// A workflow someone resumed after an auto-pause starts a fresh streak.
	const resumed =
		input.state.pausedAt !== undefined && !input.workflowIsPaused;
	const base: ScheduledRunState = resumed
		? {
				...input.state,
				consecutiveFailures: 0,
				pausedAt: undefined,
				pausedReason: undefined,
			}
		: input.state;
	const counted: ScheduledRunState = {
		...base,
		lastOutcomeExecutionId: input.executionId,
	};

	if (input.status === "COMPLETED") {
		const firstSuccess = counted.firstSuccessNotifiedAt === undefined;
		return {
			state: {
				...counted,
				consecutiveFailures: 0,
				...(firstSuccess ? { firstSuccessNotifiedAt: input.now } : {}),
			},
			firstSuccess,
			pause: false,
		};
	}

	if (input.status === "FAILED") {
		const consecutiveFailures = base.consecutiveFailures + 1;
		const failed = { ...counted, consecutiveFailures };
		const pause =
			input.workflowIsLive &&
			consecutiveFailures >= PAUSE_AFTER_CONSECUTIVE_FAILURES;
		return {
			state: pause
				? pausedState(
						failed,
						`Paused automatically after ${consecutiveFailures} failed runs in a row.`,
						input.now,
					)
				: failed,
			firstSuccess: false,
			pause,
		};
	}

	return { state: counted, firstSuccess: false, pause: false };
}
