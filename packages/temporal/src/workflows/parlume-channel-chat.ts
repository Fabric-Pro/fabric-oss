import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
	ParentClosePolicy,
	proxyActivities,
	sleep,
	startChild,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import { parlumeRecapWorkflow } from "./parlume-recap";

const { tickParlumeChannelChat } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 seconds",
	retry: { maximumAttempts: 3, initialInterval: "2 seconds" },
});

/** Per-session subscription ownership; there is no channel-history polling. */
export async function parlumeChannelChatWorkflow(input: {
	sessionId: string;
	organizationId: string;
	hardStopAt: string;
}): Promise<void> {
	const stopAt = Date.parse(input.hardStopAt);
	let recapStarted = false;
	do {
		try {
			const result = await tickParlumeChannelChat(input);
			if (result.routingReady && !recapStarted) {
				try {
					await startChild(parlumeRecapWorkflow, {
						workflowId: `parlume-recap-${input.sessionId}`,
						workflowIdReusePolicy: "REJECT_DUPLICATE",
						parentClosePolicy: ParentClosePolicy.ABANDON,
						args: [{ sessionId: input.sessionId }],
					});
					recapStarted = true;
				} catch (error) {
					if (error instanceof WorkflowExecutionAlreadyStartedError) {
						recapStarted = true;
					} else {
						throw error;
					}
				}
			}
			if (!result.continue) {
				return;
			}
		} catch {
			// A web outage must not abandon an otherwise live session. Graph's
			// short expiration stops notifications if renewal remains unavailable.
		}
		if (Date.now() >= stopAt) {
			break;
		}
		await sleep(Math.min(30_000, stopAt - Date.now()));
	} while (Date.now() < stopAt);
	await tickParlumeChannelChat(input);
}
