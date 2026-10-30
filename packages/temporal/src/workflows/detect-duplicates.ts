/**
 * Fire-and-forget workflow that runs automatic semantic duplicate detection
 * over newly-created stories in the background.
 *
 * Started (not awaited) by `triggerDuplicateDetection` from the AI create
 * paths — AI Update (`applyBacklogChanges`), Teams/Slack proposal approval, and
 * the `fabric_create_story` agent tool. Moving detection here (vs running it
 * inline in the create request) means:
 *   1. the create/approval returns immediately (detection never blocks it), and
 *   2. each detection activity is RETRIED with backoff, so a transient
 *      embedding/LLM rate-limit error under burst load no longer silently skips
 *      detection (the bug surfaced by approving many channel proposals at once).
 *
 * One activity call is one scan run, which verifies at most
 * MAX_LLM_VERIFICATIONS pairs and stops starting verifications after
 * RUN_TIME_BUDGET_MS; the workflow runs the activity again while pairs are
 * left over, so each run gets its own timeout and retries. (Looping inside one
 * activity could not work: a full run takes minutes, so a second never fit its
 * timeout.) No signals/queries.
 */

import { patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { detectDuplicateStoriesActivity } = proxyActivities<typeof activities>({
	// A run stops starting verifications after RUN_TIME_BUDGET_MS (7 minutes);
	// the rest covers the verification in flight and the cache writes.
	startToCloseTimeout: "10m",
	retry: {
		initialInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 6,
		maximumInterval: "2m",
	},
});

export interface DetectDuplicatesWorkflowInput {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	/** IDs of the just-created stories to check against the existing backlog. */
	targetStoryIds: string[];
}

export interface DetectDuplicatesWorkflowOutput {
	scanned: number;
	candidates: number;
	confirmed: number;
	truncated: number;
}

/** Most scan runs one detection makes while candidate pairs are left over. */
const MAX_DETECTION_RUNS = 5;

export async function detectDuplicatesWorkflow(
	input: DetectDuplicatesWorkflowInput,
): Promise<DetectDuplicatesWorkflowOutput> {
	let run = await detectDuplicateStoriesActivity(input);
	// Executions started before the runs moved here made one activity call.
	if (!patched("detect-duplicates-runs-in-workflow")) {
		return run;
	}
	const total: DetectDuplicatesWorkflowOutput = {
		scanned: run.scanned,
		candidates: run.candidates,
		confirmed: run.confirmed,
		truncated: run.truncated,
	};
	// Run again while pairs were left over and the last run verified every
	// pair it tried. A run with failed pairs stops here rather than hammering
	// a struggling verifier; its items stay stale, so the next scan retries
	// them.
	for (
		let runs = 1;
		runs < MAX_DETECTION_RUNS &&
		run.truncated > 0 &&
		run.verifierFailures === 0;
		runs++
	) {
		run = await detectDuplicateStoriesActivity(input);
		total.scanned = run.scanned;
		total.candidates += run.candidates;
		total.confirmed += run.confirmed;
		total.truncated = run.truncated;
	}
	return total;
}
