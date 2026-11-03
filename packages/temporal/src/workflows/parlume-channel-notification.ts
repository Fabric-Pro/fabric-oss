import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
	ParentClosePolicy,
	proxyActivities,
	startChild,
} from "@temporalio/workflow";
import type * as activities from "../activities";

type ChannelNotificationJob = {
	sessionId: string;
	organizationId: string;
	subscriptionId: string;
	replyId: string;
	hardStopAt: string;
};

export async function parlumeChannelNotificationWorkflow(
	job: ChannelNotificationJob,
): Promise<void> {
	const remaining = Date.parse(job.hardStopAt) - Date.now();
	if (remaining <= 0) {
		return;
	}
	const { deliverParlumeChannelNotificationActivity } = proxyActivities<
		typeof activities
	>({
		startToCloseTimeout: "30 seconds",
		scheduleToCloseTimeout: Math.min(5 * 60_000, remaining),
		retry: {
			maximumAttempts: 8,
			initialInterval: "2 seconds",
			maximumInterval: "15 seconds",
		},
	});
	await deliverParlumeChannelNotificationActivity(job);
}

/** The webhook durably records this bounded metadata batch in one RPC. */
export async function parlumeChannelNotificationIngressWorkflow(input: {
	jobs: ChannelNotificationJob[];
}): Promise<void> {
	for (let offset = 0; offset < input.jobs.length; offset += 20) {
		await Promise.all(
			input.jobs.slice(offset, offset + 20).map(async (job) => {
				if (Date.parse(job.hardStopAt) <= Date.now()) {
					return;
				}
				try {
					await startChild(parlumeChannelNotificationWorkflow, {
						workflowId: `parlume-channel-message:${encodeURIComponent(job.sessionId)}:${encodeURIComponent(job.replyId)}`,
						workflowIdReusePolicy: "REJECT_DUPLICATE",
						parentClosePolicy: ParentClosePolicy.ABANDON,
						args: [job],
					});
				} catch (error) {
					if (
						!(error instanceof WorkflowExecutionAlreadyStartedError)
					) {
						throw error;
					}
				}
			}),
		);
	}
}
