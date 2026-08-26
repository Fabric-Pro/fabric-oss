import { log, proxyActivities } from "@temporalio/workflow";
import type {
	dispatchDocumentRefreshActivity as DispatchFn,
	findDueDocumentsActivity as FindDueFn,
} from "../activities/document-refresh";

/**
 * Hourly sweep for Living Documents auto-refresh.
 *
 * The workflow reads no clock and holds no cadence logic — the find-due
 * activity owns "now", which is what keeps this replay-deterministic. Mirrors
 * `newsletterDispatcherWorkflow`.
 */

const { findDueDocumentsActivity } = proxyActivities<{
	findDueDocumentsActivity: typeof FindDueFn;
}>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

const { dispatchDocumentRefreshActivity } = proxyActivities<{
	dispatchDocumentRefreshActivity: typeof DispatchFn;
}>({
	startToCloseTimeout: "1 minute",
	heartbeatTimeout: "30 seconds",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

export async function documentRefreshDispatcherWorkflow(): Promise<{
	dispatched: number;
}> {
	const { due } = await findDueDocumentsActivity();

	// Dispatches are independent (each is one workflow-start RPC) and idempotent
	// (the workflow id dedupes), so there is nothing to serialize on. Running them
	// one at a time would make a long due-list take a long tick — and the schedule
	// is `overlap: "SKIP"`, so a long tick silently swallows the next one and the
	// backlog feeds itself.
	const results = await Promise.allSettled(
		due.map((document) => dispatchDocumentRefreshActivity(document)),
	);

	let dispatched = 0;
	results.forEach((result, i) => {
		if (result.status === "fulfilled") {
			dispatched += 1;
			return;
		}
		// One document's failure must not block the rest of the sweep.
		log.error("[DocumentRefresh] dispatch failed for document", {
			documentId: due[i]?.documentId,
			error:
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason),
		});
	});

	return { dispatched };
}
