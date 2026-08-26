/**
 * Draft Proposal Body Workflow
 *
 * Runs ONE persisted, in-review draft of a pending proposal's body through the
 * project's Bug/Feature prompt, off the request path. Started by the inbox after
 * it atomically claims the `(proposalId, kind)` slot, so exactly one workflow
 * runs per (proposal, kind) regardless of how many users/tabs opened it.
 *
 * Thin + deterministic — all the LLM/DB work is in the activity, so it's
 * replay-safe. Cancelling this workflow (reviewer proceeded with creation before
 * the draft finished) stops the run; the draft row is set CANCELLED by the
 * caller and the activity's compare-and-set write is dropped.
 */

import { proxyActivities } from "@temporalio/workflow";
import type {
	draftProposalBodyActivity as DraftProposalBodyActivityFn,
	DraftProposalBodyInput,
} from "../activities/backlog-context/draft-proposal-body";

const { draftProposalBodyActivity } = proxyActivities<{
	draftProposalBodyActivity: typeof DraftProposalBodyActivityFn;
}>({
	// The draft is a single ~minute LLM call; liveness is the heartbeatTimeout,
	// so a generous wall-clock is safe. The activity handles its own draft
	// errors (marks the row FAILED), so retries only guard infra hiccups.
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

export async function draftProposalBodyWorkflow(
	input: DraftProposalBodyInput,
): Promise<void> {
	await draftProposalBodyActivity(input);
}
