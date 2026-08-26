import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { getTemporalClient } from "../../client";
import type { DueDocument } from "./find-due-documents";

/**
 * Starts one document's refresh as its own workflow.
 *
 * The sweep does NOT do the work inline: a refresh is a slow model call, and
 * running them in sequence inside the sweep would let one slow document delay
 * every other. Fanning out to a root workflow per document also gives each its
 * own retry policy and history.
 *
 * Idempotency comes from the deterministic workflow id (document + cadence
 * period) rather than a dedupe table: a retried dispatch, or a sweep that fires
 * again while a refresh is still running, reuses the id and Temporal rejects the
 * duplicate start. Same model as the newsletter dispatcher.
 */
export async function dispatchDocumentRefreshActivity(
	due: DueDocument,
): Promise<void> {
	heartbeat("dispatchDocumentRefresh");

	try {
		const client = await getTemporalClient();
		await client.workflow.start("documentRefreshWorkflow", {
			taskQueue: "document-refresh",
			workflowId: due.workflowId,
			args: [due],
			// ALLOW_DUPLICATE is LOAD-BEARING, not a default we inherited by
			// accident. The workflow id contains the cadence bucket, which is 7-30
			// days wide, while a failed refresh retries after 6 hours — under the
			// same id. Anyone "hardening" this to REJECT_DUPLICATE would silently
			// stop every failed document from ever retrying, for up to a month.
			workflowIdReusePolicy: "ALLOW_DUPLICATE",
			// A refresh is one model call plus a write. If it has not finished in an
			// hour it is wedged, and the next sweep should get a clean slate.
			workflowExecutionTimeout: "1 hour",
		});
	} catch (error) {
		if (error instanceof WorkflowExecutionAlreadyStartedError) {
			// A refresh for this document is already RUNNING (that is the only case
			// this error covers — a closed one's id is reusable). Not an error: it is
			// what stops a slow refresh from being dispatched twice by consecutive
			// sweeps.
			logger.info("[DocumentRefresh] A refresh is already running", {
				documentId: due.documentId,
				workflowId: due.workflowId,
			});
			return;
		}
		throw error;
	}
}
