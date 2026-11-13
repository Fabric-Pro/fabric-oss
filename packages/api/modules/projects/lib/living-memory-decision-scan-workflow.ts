/**
 * Start the scan a member asks for from the Decisions tab: the synced Living
 * Memory files not read for decisions yet, whether a repository's first sync
 * skipped them or their current version was never read. The workflow lives in
 * `@repo/temporal` and is started by its registered name. `requestedByUserId`
 * is the member who asked: the project's other reviewers are notified of the
 * candidates the scan finds, and that member is not.
 */
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

const FIRST_SYNC_SCAN_WORKFLOW = "livingMemoryDecisionFirstSyncScanWorkflow";

const FIRST_SYNC_SCAN_TASK_QUEUE = "fabric-worker";

/**
 * Start it for the project. `false` means Temporal refused the id because a
 * scan is already open. Any other failure throws.
 */
export async function startLivingMemoryFirstSyncScan(input: {
	projectId: string;
	organizationId: string | null;
	requestedByUserId: string;
}): Promise<boolean> {
	const client = await getTemporalClient();
	try {
		await client.workflow.start(
			FIRST_SYNC_SCAN_WORKFLOW,
			withCorrelationMemo({
				taskQueue: FIRST_SYNC_SCAN_TASK_QUEUE,
				workflowId: `living-memory-decisions-first-sync-scan-${input.projectId}`,
				workflowIdConflictPolicy: "FAIL",
				args: [input],
			}),
		);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "WorkflowExecutionAlreadyStartedError"
		) {
			return false;
		}
		throw error;
	}
}
