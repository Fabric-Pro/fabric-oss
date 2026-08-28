/**
 * Conversation-Bundle Embedding Recovery Workflow (Fizzy #2228, U11).
 *
 * Scheduled (see `packages/temporal/src/schedules.ts`) and delegating entirely
 * to `sweepConversationBundleEmbeddingsActivity`, which finishes captured
 * channel bundles whose embed failed or whose worker died mid-write. U5 made
 * those failures non-fatal, so the monitor activity completes and Temporal has
 * nothing to retry — this schedule is the only thing that comes back for them.
 *
 * The workflow body is deterministic: no `Date.now()`, no env reads, no IO, and
 * no branch on an activity result. Replay stays clean (CLAUDE.md replay rule;
 * CI replay validation fires on `workflows/**` changes).
 *
 * ONE activity call, not a drain loop. A bundle whose embed fails hands its
 * lease straight back so the next pass can retry promptly — which means a loop
 * inside a single run would re-select the same failing rows for every batch and
 * spend the whole run on them. The batch ceiling plus the cron cadence is the
 * throughput control instead, and the activity reports whether its batch came
 * back full so a backlog that never drains is visible in the logs rather than
 * silent.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/conversation-bundle-embedding-sweep";

const { sweepConversationBundleEmbeddingsActivity } = proxyActivities<
	typeof activities
>({
	// A bounded batch of embedding round trips against a provider that can be
	// slow under load. Comfortably above the worst realistic batch, and well
	// under the schedule's interval so a wedged run cannot swallow the next
	// trigger under `overlap: "SKIP"`.
	startToCloseTimeout: "10 minutes",
	// The activity heartbeats once per bundle, so a genuinely stuck provider
	// call is caught long before the start-to-close ceiling.
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "30 seconds",
		backoffCoefficient: 2,
		maximumInterval: "2 minutes",
		// Three attempts, then leave it: every row this pass would have
		// recovered is still in the queue, and the next scheduled tick is a
		// better retry than an aggressive one against a provider that is
		// evidently unwell.
		maximumAttempts: 3,
	},
});

export type ConversationBundleEmbeddingSweepInput =
	activities.SweepConversationBundleEmbeddingsInput;
export type ConversationBundleEmbeddingSweepOutput =
	activities.SweepConversationBundleEmbeddingsOutput;

export async function conversationBundleEmbeddingSweepWorkflow(
	input: ConversationBundleEmbeddingSweepInput = {},
): Promise<ConversationBundleEmbeddingSweepOutput> {
	return await sweepConversationBundleEmbeddingsActivity(input);
}
