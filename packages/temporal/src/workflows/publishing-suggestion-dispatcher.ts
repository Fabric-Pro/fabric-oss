/**
 * Publishing Suggestion — daily dispatcher (Publishing Suite 1A, Task 10).
 *
 * Mirrors `newsletter-dispatcher.ts`: a sequential per-project loop with a
 * per-item try/catch so one project's failure never blocks the rest of the
 * sweep. DETERMINISM (N6): the flag and "now" are read in the ACTIVITIES
 * (`findEligibleProjects`, `dispatchPublishingSuggestion`), never here — this
 * workflow only loops over the returned ids.
 */

import { log, proxyActivities, workflowInfo } from "@temporalio/workflow";
import type * as acts from "../activities/publishing-suggestion";

const { findEligibleProjects, dispatchPublishingSuggestion } = proxyActivities<
	typeof acts
>({
	startToCloseTimeout: "1 minute",
	heartbeatTimeout: "30 seconds",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

export async function publishingSuggestionDispatcherWorkflow(): Promise<{
	dispatched: number;
}> {
	const { projects } = await findEligibleProjects();
	// N2 (retry-idempotency): the deterministic runId is STABLE across the dispatch
	// activity's retries within THIS dispatcher execution and DISTINCT per daily run
	// — exactly the per-dispatch-run occurrence-key semantics (no midnight hole).
	// `workflowInfo()` is determinism-safe. Scoped per (projectId, runId) downstream,
	// so all projects in one sweep sharing this id still dedupe only per project.
	const dispatcherRunId = workflowInfo().runId;
	let dispatched = 0;
	for (const p of projects) {
		try {
			await dispatchPublishingSuggestion({
				projectId: p.projectId,
				dispatcherRunId,
			});
			dispatched += 1;
		} catch (error) {
			// One project's failure must not block the rest of the sweep.
			log.error("[PublishingSuite] dispatch failed", {
				projectId: p.projectId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { dispatched };
}
