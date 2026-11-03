import { type ScheduleClient, ScheduleNotFoundError } from "@temporalio/client";
import { classifyTemporalClientError } from "../lib/temporal-client-errors";

export const AGENT_RECEIPT_RECOVERY_SCHEDULE_ID =
	"agent-execution-receipt-recovery";
export const AGENT_RECEIPT_RECOVERY_TASK_QUEUE = "fabric-worker";

/** New workflows persist identity through native Activity retries; stop the former observer. */
export async function retireAgentExecutionReceiptRecoverySchedule(
	client: ScheduleClient,
) {
	try {
		await client
			.getHandle(AGENT_RECEIPT_RECOVERY_SCHEDULE_ID)
			.pause(
				"Native agent workflows now persist their own execution identity; periodic receipt observation retired.",
			);
	} catch (error) {
		if (
			!(error instanceof ScheduleNotFoundError) &&
			classifyTemporalClientError(error) !== "not_found"
		) {
			throw error;
		}
	}
}
