/**
 * Direct Chat Post-Operation Workflow.
 *
 * # Why this exists
 *
 * Originally `directChatWorkflow` made the Step 6 `postOperationResultActivity`
 * call inline before returning. The SSE route at
 * `apps/web/app/api/agents/fabric-ai/stream/route.ts` polls `handle.describe()`
 * and only emits the final SSE event after `handle.result()` resolves —
 * i.e. after the workflow has fully completed.
 *
 * That made user-perceived completion latency dependent on Step 6's
 * latency: with `scheduleToCloseTimeout: "2 minutes"` on the activity
 * proxy, a worker outage or backed-up activity queue could delay the
 * SSE "done" event by up to two minutes AFTER the AI response was
 * already fully streamed via heartbeat queries. The chat would appear
 * stuck. AC-2 (persistence) was leaking into AC-5-ish (perceived
 * snappiness).
 *
 * The fix mirrors the orchestrator's solution
 * (`orchestrator/phases/completion.ts:749` — `await
 * startChild(orchestratorCompletionWorkflow, { parentClosePolicy:
 * ABANDON, … })`): persist the operation-result message from a
 * fire-and-forget CHILD workflow started with
 * `ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON`. The parent
 * `await`s ONLY the child's start (milliseconds), not its completion.
 * The child runs independently; if the parent has already returned and
 * the user has navigated away, the child still finishes its DB write
 * + Realtime emit.
 *
 * # Why the outcome / summary / label are computed in the PARENT
 *
 * The parent workflow has the full `DirectChatActivityResult` shape
 * (with `result.success` distinguishing the "AI execution returned
 * `{success:false}` without throwing" case that Copilot's review
 * caught — see commit `dXXXXXX` and the doc block in the parent's
 * success branch). Computing the outcome there keeps this child
 * workflow as a thin shell with no business logic of its own — a
 * pure adapter between the parent and the `postOperationResultActivity`.
 *
 * # Cancellation semantics
 *
 *   - `ParentClosePolicy.ABANDON` decouples this child from the
 *     parent's lifecycle once it has STARTED. A parent-Cancel that
 *     arrives AFTER startChild returns will not propagate.
 *   - `CancellationScope.nonCancellable` inside this workflow further
 *     protects the activity call from any locally-triggered Cancel
 *     (e.g. a workflow-level Cancel signal). Belt-and-braces on top of
 *     ABANDON, in case a future change introduces a per-child cancel
 *     surface.
 *
 * # Idempotency
 *
 * The `operationKey` is computed and passed by the parent so
 * `appendConversationMessage` deduplicates on workflow retry. See the
 * parent (`direct-chat.ts`) for the `${executionId}-result` shape.
 */

import type {
	OperationArtifact,
	OperationOutcome,
} from "@repo/utils/operation-result-message";
import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type * as postOperationResultModule from "../activities/post-operation-result";

// Proxy block intentionally duplicated from the parent's proxy. We need
// the activity reachable from this child workflow's bundle, and the
// timeout posture is identical: short single-attempt bound + a whole-
// schedule cap that survives a brief worker outage. The activity itself
// catches all errors (returns `{ posted: false, reason }`) so retries
// here are only for transient temporal-platform failures.
const { postOperationResultActivity } = proxyActivities<
	typeof postOperationResultModule
>({
	startToCloseTimeout: "30 seconds",
	scheduleToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "5s",
		maximumAttempts: 2,
	},
});

/**
 * Serialisable input for the child workflow. All fields are required so
 * the parent is forced to derive `outcome` / `summary` / `operationLabel`
 * before calling `startChild` — that derivation has access to the AI
 * activity's typed result shape and is the right place to branch on
 * `result.success`.
 */
export interface DirectChatPostOperationInput {
	readonly conversationId: string;
	readonly userId: string;
	readonly organizationId: string | null;
	readonly operationKey: string;
	readonly outcome: OperationOutcome;
	readonly operationLabel: string;
	readonly summary: string;
	readonly artifact?: OperationArtifact;
	readonly errorCode?: string;
}

/**
 * Fire-and-forget child workflow that persists the operation-result
 * system message. The parent starts this via `startChild(..., {
 * parentClosePolicy: PARENT_CLOSE_POLICY_ABANDON })` and does NOT await
 * its completion.
 */
export async function directChatPostOperationWorkflow(
	input: DirectChatPostOperationInput,
): Promise<void> {
	try {
		await CancellationScope.nonCancellable(async () => {
			const result = await postOperationResultActivity({
				conversationId: input.conversationId,
				userId: input.userId,
				organizationId: input.organizationId,
				operationKey: input.operationKey,
				outcome: input.outcome,
				operationLabel: input.operationLabel,
				summary: input.summary,
				artifact: input.artifact,
				errorCode: input.errorCode,
			});
			log.info("directChatPostOperationWorkflow — activity processed", {
				operationKey: input.operationKey,
				outcome: input.outcome,
				posted: result.posted,
				deduplicated: result.deduplicated,
				reason: result.reason,
			});
		});
	} catch (error) {
		// Belt-and-braces — the activity's own catch swallows app errors.
		// This catch handles a retry-exhausted proxy failure or other
		// platform-level error. We swallow + log; this is a fire-and-
		// forget child whose failure must never surface anywhere.
		log.warn(
			"directChatPostOperationWorkflow — non-fatal failure (swallowed)",
			{
				operationKey: input.operationKey,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}
