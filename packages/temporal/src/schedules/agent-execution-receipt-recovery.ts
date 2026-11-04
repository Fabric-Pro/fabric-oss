import type { ScheduleClient } from "@temporalio/client";

export const AGENT_RECEIPT_RECOVERY_SCHEDULE_ID =
	"agent-execution-receipt-recovery";
export const AGENT_RECEIPT_RECOVERY_TASK_QUEUE = "fabric-worker";

const GRPC_NOT_FOUND = 5;

function isMissingScheduleError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current && depth < 6; depth++) {
		if (
			current instanceof Error &&
			(current.name === "ScheduleNotFoundError" ||
				current.name === "WorkflowNotFoundError")
		) {
			return true;
		}
		if (
			typeof current === "object" &&
			(current as { code?: unknown }).code === GRPC_NOT_FOUND
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** New workflows persist identity through native Activity retries; stop the former observer. */
export async function retireAgentExecutionReceiptRecoverySchedule(
	client: ScheduleClient,
) {
	if (typeof client.getHandle !== "function") {
		return;
	}
	const handle = client.getHandle(AGENT_RECEIPT_RECOVERY_SCHEDULE_ID);
	if (typeof handle?.pause !== "function") {
		return;
	}
	try {
		await handle.pause(
			"Native agent workflows now persist their own execution identity; periodic receipt observation retired.",
		);
	} catch (error) {
		if (!isMissingScheduleError(error)) {
			throw error;
		}
	}
}
