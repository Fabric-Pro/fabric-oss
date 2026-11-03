import { withCorrelationMemo } from "@repo/api/lib/temporal-correlation";
import { getTemporalClient } from "@repo/temporal/client";
import { classifyTemporalClientError } from "@repo/temporal/temporal-client-errors";

export async function startParlumeChannelChat(input: {
	sessionId: string;
	organizationId: string;
	hardStopAt: string;
}): Promise<void> {
	try {
		const client = await getTemporalClient();
		await client.workflow.start(
			"parlumeChannelChatWorkflow",
			withCorrelationMemo({
				taskQueue: "fabric-worker",
				workflowId: `parlume-channel-chat-${input.sessionId}`,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				args: [input],
			}),
		);
	} catch (error) {
		if (classifyTemporalClientError(error) !== "already_started") {
			throw error;
		}
	}
}
