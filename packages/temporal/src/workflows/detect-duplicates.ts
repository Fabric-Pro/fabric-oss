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
 *
 * The verifier may run on an organization's shared ChatGPT plans (job type
 * "duplicate-detection", Fizzy #3538). When a run's model resolution is
 * refused because the plans it may use are spent, the run fails with
 * `SubscriptionPlanExhaustedError`; the workflow then waits for the estimated
 * reset (capped by the helper) and makes that run once more
 * (`withChatGptPlanWait`). A refusal part-way through the pairs is still a
 * failed pair inside the activity.
 */

import { patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { withChatGptPlanWait } from "./lib/chatgpt-plan-wait";

const { detectDuplicateStoriesActivity } = proxyActivities<typeof activities>({
	// A run stops starting verifications after RUN_TIME_BUDGET_MS (7 minutes);
	// the rest covers the verification in flight and the cache writes.
	startToCloseTimeout: "10m",
	retry: {
		initialInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 6,
		maximumInterval: "2m",
		// Retrying cannot refill a spent ChatGPT plan; `withChatGptPlanWait`
		// waits for a reset instead (Fizzy #3538). Retry options are not part
		// of the command sequence, so no `patched()` guard.
		nonRetryableErrorTypes: ["SubscriptionPlanExhaustedError"],
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
	// Each run waits out a spent plan on its own and is made once more; a
	// second refusal fails the workflow. No stopped notice: no one asked for
	// this check, and the items stay stale for the next scan. The helper's own
	// `patched()` keeps older histories unchanged.
	const detect = () =>
		withChatGptPlanWait(() => detectDuplicateStoriesActivity(input), {
			organizationId: input.organizationId,
			userId: input.userId,
		});
	let run = await detect();
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
		run = await detect();
		total.scanned = run.scanned;
		total.candidates += run.candidates;
		total.confirmed += run.confirmed;
		total.truncated = run.truncated;
	}
	return total;
}
