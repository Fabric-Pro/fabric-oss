import { createHash } from "node:crypto";
import { withCorrelationMemo } from "@repo/api/lib/temporal-correlation";
import { withTimeout } from "@repo/api/lib/temporal-describe";
import type { channelNotificationJobSchema } from "@repo/api/modules/projects/lib/parlume-channel-chat";
import { getTemporalClient } from "@repo/temporal/client";
import { classifyTemporalClientError } from "@repo/temporal/temporal-client-errors";
import type { z } from "zod";

export async function enqueueParlumeChannelNotifications(
	jobs: z.infer<typeof channelNotificationJobSchema>[],
	deadline = Date.now() + 2_500,
): Promise<void> {
	if (jobs.length === 0) {
		return;
	}
	const key = createHash("sha256")
		.update(
			JSON.stringify(
				jobs
					.map(({ sessionId, subscriptionId, replyId }) => [
						sessionId,
						subscriptionId,
						replyId,
					])
					.sort(),
			),
		)
		.digest("hex");
	try {
		const client = await withTimeout(
			getTemporalClient(),
			Math.max(1, deadline - Date.now()),
		);
		await client.connection.withDeadline(deadline, () =>
			client.workflow.start(
				"parlumeChannelNotificationIngressWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					workflowId: `parlume-channel-ingress-${key}`,
					workflowIdReusePolicy: "REJECT_DUPLICATE",
					retry: { maximumAttempts: 3, initialInterval: "5 seconds" },
					args: [{ jobs }],
				}),
			),
		);
	} catch (error) {
		if (classifyTemporalClientError(error) !== "already_started") {
			throw error;
		}
	}
}
