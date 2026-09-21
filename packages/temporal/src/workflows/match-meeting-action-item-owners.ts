/**
 * Fire-and-forget workflow that turns ONE meeting's action items into to-do
 * rows and guesses their owners (Fizzy #2340).
 *
 * Started (not awaited) from exactly two places, and both are needed:
 *
 *  1. `extractMeetingInsightsActivity`, once a transcript's insights commit.
 *     This is the live path and covers every meeting extracted from the moment
 *     the organization's `TODO_LIST` gate is open.
 *  2. `todos.catchUp` in `@repo/api`
 *     (`modules/todos/procedures/catch-up.ts`), which the To Do page calls on
 *     open. This is the ONLY thing that reaches a meeting the live path
 *     missed, and it misses three kinds: meetings extracted before the gate
 *     opened for that organization (extraction short-circuits on
 *     `insightsExtractedAt`, so they never re-extract and never re-start this),
 *     meetings whose start threw because Temporal was unreachable, and
 *     meetings whose start was rejected by the conflict policy. The activity
 *     is what makes that reachable: it stamps `todosMatchedAt` and
 *     `todoMatchVersion` on success, and those two columns are the cursor the
 *     catch-up selects on.
 *
 * The deterministic workflowId (`meeting-todo-owner-match:<transcriptCuid>`,
 * built by `lib/meeting-todo-matcher.ts` so both sites spell it the same)
 * collapses the race between an extraction that just finished and a person
 * opening the page, and the activity's own change detection makes a re-run
 * over unchanged text write nothing. The two sites choose different conflict
 * policies against that id on purpose — see each call site.
 *
 * A NEW workflow rather than a step appended to an existing one, for the reason
 * `link-meeting-action-items.ts` beside this file records: adding an activity
 * call to an existing workflow changes its command sequence and breaks replay
 * of in-flight executions (TMPRL1100) unless gated behind `patched()`. The
 * second reason is specific to this feature — there is no single extraction
 * workflow to append to. `extractMeetingInsightsActivity` runs both from
 * `extractMeetingInsightsOnDemandWorkflow` and from
 * `dailyBriefGenerationWorkflow`, so a matcher chained onto either one would
 * produce no to-dos at all for meetings that came through the other.
 *
 * Intentionally trivial — one retried activity call, no signals or queries.
 * Unlike its linking sibling this activity makes no LLM or embedding call: the
 * match is string comparison over names already in the database, which is why
 * the timeout here is a fraction of that workflow's and the AI non-retryable
 * error types are absent.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules. No
 * `Date.now()` / `Math.random()` / IO here; every side effect, the feature-gate
 * read included, lives in the activity.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { matchMeetingActionItemOwnersActivity } = proxyActivities<
	typeof activities
>({
	// No model call anywhere in this path — a handful of indexed reads and one
	// upsert per action item. Generous headroom over that, not over an LLM.
	startToCloseTimeout: "120s",
	heartbeatTimeout: "1 minute",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "1m",
		maximumAttempts: 3,
		// A missing organization is a caller bug, not a transient fault: retrying
		// it would only refuse three times more slowly.
		nonRetryableErrorTypes: ["ValidationError", "TenantViolation"],
	},
});

export interface MatchMeetingActionItemOwnersWorkflowInput {
	projectId: string;
	organizationId: string | null;
	transcriptCuid: string;
}

export interface MatchMeetingActionItemOwnersWorkflowOutput {
	itemsConsidered: number;
	todosCreated: number;
	todosUpdated: number;
	todosOrphaned: number;
}

export async function matchMeetingActionItemOwnersWorkflow(
	input: MatchMeetingActionItemOwnersWorkflowInput,
): Promise<MatchMeetingActionItemOwnersWorkflowOutput> {
	const result = await matchMeetingActionItemOwnersActivity({
		projectId: input.projectId,
		organizationId: input.organizationId,
		transcriptCuid: input.transcriptCuid,
	});
	return {
		itemsConsidered: result.itemsConsidered,
		todosCreated: result.todosCreated,
		todosUpdated: result.todosUpdated,
		todosOrphaned: result.todosOrphaned,
	};
}
