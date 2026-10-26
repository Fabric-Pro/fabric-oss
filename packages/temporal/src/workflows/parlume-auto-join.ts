import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { planParlumeAutoJoins } = proxyActivities<typeof activities>({
	// Shorter than the five-minute schedule, which skips a tick that overlaps.
	startToCloseTimeout: "4 minutes",
	heartbeatTimeout: "1 minute",
	// The next tick is the retry: a failed plan is replanned five minutes on.
	retry: { maximumAttempts: 1 },
});

const { confirmParlumeAutoJoinOccurrence } = proxyActivities<typeof activities>(
	{
		// Its own calendar reads are retried inside; this covers a lost worker.
		startToCloseTimeout: "2 minutes",
		retry: { maximumAttempts: 2 },
	},
);

const { requestParlumeAutoJoin } = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	// Bounded so a join stays inside the ten minutes Parlume still joins late.
	retry: {
		maximumAttempts: 4,
		initialInterval: "20 seconds",
		backoffCoefficient: 2,
		nonRetryableErrorTypes: ["ParlumeAutoJoinRejected"],
	},
});

/**
 * Every five minutes: find the occurrences of auto-join series that start
 * soon and schedule a join for each.
 */
export async function parlumeAutoJoinPlannerWorkflow(): Promise<
	Awaited<ReturnType<typeof planParlumeAutoJoins>>
> {
	return planParlumeAutoJoins();
}

/**
 * Started by the planner with a delay that ends a minute before the
 * occurrence, under an id that makes it one per occurrence. The occurrence
 * is confirmed on the calendar again first, since it may have been cancelled
 * or moved while the workflow waited.
 */
export async function parlumeAutoJoinOccurrenceWorkflow(input: {
	linkedMeetingId: string;
	occurrenceStart: string;
}): Promise<{ outcome: string; reason?: string }> {
	const confirmed = await confirmParlumeAutoJoinOccurrence(input);
	if (!confirmed.proceed) {
		return { outcome: confirmed.outcome, reason: confirmed.reason };
	}
	return requestParlumeAutoJoin(input);
}
