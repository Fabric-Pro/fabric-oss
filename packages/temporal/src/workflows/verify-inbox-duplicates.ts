/**
 * Fire-and-forget workflow that verifies the Proposal Inbox's duplicate
 * candidates in the background, so the inbox never waits on the verifier.
 *
 * Started by `startInboxDuplicateVerification` from the inbox's duplicate
 * check with the candidate pairs that have no current verdict. One run per
 * project at a time: a check made while one runs joins it, and the pairs it
 * left are asked for again by the inbox's next check, once this run is
 * done. One activity call verifies at most MAX_LLM_VERIFICATIONS pairs. No
 * signals or queries.
 *
 * The verifier may run on an organization's shared ChatGPT plans (job type
 * "duplicate-detection"), as the roadmap's automatic duplicate check does.
 * When the plans it may use are spent, the run waits for the estimated reset
 * and makes the call once more (`withChatGptPlanWait`), rather than failing
 * on every check of the inbox meanwhile.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { withChatGptPlanWait } from "./lib/chatgpt-plan-wait";

const { verifyInboxDuplicatesActivity } = proxyActivities<typeof activities>({
	// A run stops starting verifications after RUN_TIME_BUDGET_MS (7 minutes);
	// the rest covers the verifications in flight.
	startToCloseTimeout: "10m",
	retry: {
		initialInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 4,
		maximumInterval: "2m",
		// Retrying cannot refill a spent ChatGPT plan; `withChatGptPlanWait`
		// waits for a reset instead.
		nonRetryableErrorTypes: ["SubscriptionPlanExhaustedError"],
	},
});

export async function verifyInboxDuplicatesWorkflow(
	input: activities.VerifyInboxDuplicatesParams,
): Promise<void> {
	// A second refusal fails the run. No stopped notice: no one asked for
	// this check, and the pairs stay unverified for the inbox's next check.
	await withChatGptPlanWait(() => verifyInboxDuplicatesActivity(input), {
		organizationId: input.organizationId,
		userId: input.userId,
	});
}
