import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { getTemporalClient } from "@repo/temporal/client";
import { classifyTemporalClientError } from "@repo/temporal/temporal-client-errors";

/**
 * Starts the "Since last time" recap for a session that has just been
 * admitted to a meeting of a linked series. The workflow id is derived from
 * the session and a closed run is never started again, so however often the
 * start is repeated the meeting gets at most one recap. Best effort: a failed
 * start is logged and the meeting goes on without one.
 */
export async function startParlumeRecap(sessionId: string): Promise<void> {
	try {
		const temporal = await getTemporalClient();
		await temporal.workflow.start("parlumeRecapWorkflow", {
			taskQueue: "fabric-worker",
			workflowId: `parlume-recap-${sessionId}`,
			workflowIdReusePolicy: "REJECT_DUPLICATE",
			args: [{ sessionId }],
		});
	} catch (error) {
		if (classifyTemporalClientError(error) === "already_started") {
			return;
		}
		parlumeLog("warn", "recap.start_failed", {
			sessionId,
			error:
				error instanceof Error
					? error.message.slice(0, 300)
					: "Unknown error",
		});
	}
}
