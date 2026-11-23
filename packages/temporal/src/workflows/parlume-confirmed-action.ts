import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { executeConfirmedParlumeAction, failConfirmedParlumeAction } =
	proxyActivities<typeof activities>({
		startToCloseTimeout: "5 minutes",
		retry: { maximumAttempts: 1 },
	});

/**
 * One change Parlume proposed in a meeting, run once a member confirmed it in
 * Fabric. The grant was minted for that member; it travels only in this
 * input. Never retried: a change whose run stopped is recorded as unknown.
 */
export async function parlumeConfirmedActionWorkflow(input: {
	actionId: string;
	actingGrant?: string;
}): Promise<void> {
	try {
		await executeConfirmedParlumeAction(input);
	} catch {
		await failConfirmedParlumeAction({ actionId: input.actionId });
	}
}
