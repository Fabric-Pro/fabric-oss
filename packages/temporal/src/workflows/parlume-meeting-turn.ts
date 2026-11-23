import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

// The turn heartbeats every second, so a stop or a pause, which cancels this
// workflow, reaches it with its next heartbeat. The timeout leaves room for a
// busy worker: the floor has already silenced the answer and the bridge
// refuses its posts, so a later delivery is not heard. One attempt only: an
// answered turn must never run again, and Temporal never retries a cancelled
// activity. (Activity timeout changes are replay-safe: no `patched()` needed.)
const { executeParlumeMeetingTurn } = proxyActivities<typeof activities>({
	startToCloseTimeout: "3 minutes",
	heartbeatTimeout: "15 seconds",
	retry: { maximumAttempts: 1 },
});

const { failParlumeMeetingTurn } = proxyActivities<typeof activities>({
	startToCloseTimeout: "3 minutes",
	retry: { maximumAttempts: 1 },
});

export async function parlumeMeetingTurnWorkflow(input: {
	turnId: string;
	actingGrant?: string;
	/** The realtime voice's job this turn answers; its result is spoken there. */
	realtimeJob?: string;
	/** Everyone present may hear the meeting's confidential part. */
	withConfidential?: boolean;
}): Promise<void> {
	try {
		await executeParlumeMeetingTurn(input);
	} catch {
		// The chat is told, unless the realtime voice asked: it says so
		// itself. A turn someone stopped is no longer running, and stays
		// quiet.
		await failParlumeMeetingTurn({
			turnId: input.turnId,
			error: "Parlume meeting turn timed out or the worker stopped.",
			chatReason: input.realtimeJob ? undefined : "timed_out",
		});
	}
}
