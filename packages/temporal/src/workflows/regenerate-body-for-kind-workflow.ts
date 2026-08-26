/**
 * Regenerate Body For Kind Workflow
 *
 * Runs ONE regeneration of a converted work item's body through its new type's
 * template (Fizzy #2048). Started by the conversion once the kind flip has
 * landed, off the request path — the redraft is a model call on the order of a
 * minute, and blocking the conversion request on it would hang the UI.
 *
 * Started under a deterministic per-item workflow id, so a user alternating an
 * item's type never has more than one regeneration in flight for that item on a
 * task queue shared with interactive AI paths.
 *
 * Thin and deterministic: every DB and model call lives in the activity, so this
 * stays replay-safe. The flip and the regeneration are deliberately separate
 * steps — a failed regeneration leaves a valid, converted work item with its
 * prior body rather than a half-written one.
 *
 * It also closes the Job Hub row the conversion opened. The redraft's outcome is
 * a TYPED status, not a throw — the activity resolves every expected refusal
 * into one — so the close is driven off that status rather than off control
 * flow, and only the one status that actually wrote a body closes green.
 */

import { proxyActivities } from "@temporalio/workflow";
import type { closeRegenerationJobActivity as CloseRegenerationJobActivityFn } from "../activities/stories/close-regeneration-job";
import type {
	regenerateBodyForKindActivity as RegenerateBodyForKindActivityFn,
	RegenerateBodyForKindInput,
	RegenerateBodyForKindResult,
} from "../activities/stories/regenerate-body-for-kind";

const { regenerateBodyForKindActivity } = proxyActivities<{
	regenerateBodyForKindActivity: typeof RegenerateBodyForKindActivityFn;
}>({
	// One ~minute LLM call; liveness is the heartbeatTimeout, so a generous
	// wall-clock is safe. The activity resolves its own refusals (no model, empty
	// or collapsed redraft, lost race) into a returned status rather than a
	// throw, so retries only guard infra hiccups — and a retry is safe because
	// the write runs under the row version captured at the start of the attempt.
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

const { closeRegenerationJobActivity } = proxyActivities<{
	closeRegenerationJobActivity: typeof CloseRegenerationJobActivityFn;
}>({
	// A single compare-and-set on one row. Retried a little harder than the
	// redraft because a row left open is a job the watchdog later misreports as
	// timed out, on work that in fact finished.
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * Everything the conversion hands over.
 *
 * `targetKind` and `entryPoint` ride along beyond what the redraft itself needs:
 * the entry point is the ONLY source for the resolution log's "from which entry
 * point" dimension (NFR1) — nothing in the activity can tell one caller of this
 * workflow from another — and the target kind is carried for correlation, NOT as
 * a template decision. The activity reads the kind back off the stored row,
 * because a caller-supplied kind is a claim rather than a fact.
 */
export interface RegenerateBodyForKindWorkflowInput
	extends RegenerateBodyForKindInput {
	targetKind: "BUG" | "FEATURE";
	entryPoint: string;
}

export async function regenerateBodyForKindWorkflow(
	input: RegenerateBodyForKindWorkflowInput,
): Promise<RegenerateBodyForKindResult> {
	// Destructured and forwarded in full: BOTH halves of the tenant reach the
	// activity, and from there `draftBodyByKind`. Dropping `organizationId`
	// resolves the template and the AI model settings in personal context
	// without failing, which is the quiet way an org's customized template stops
	// being the one that runs.
	const { storyId, projectId, organizationId, userId, entryPoint } = input;

	let result: RegenerateBodyForKindResult;
	try {
		result = await regenerateBodyForKindActivity({
			storyId,
			projectId,
			organizationId,
			userId,
			entryPoint,
		});
	} catch (error) {
		// Infrastructure, not a refusal — the activity turns every refusal it
		// anticipates into a status. Close the row before rethrowing, or the user
		// watches a spinner until the watchdog stamps a generic timeout on it.
		await closeRegenerationJobActivity({
			storyId,
			status: "workflow_error",
		});
		throw error;
	}

	await closeRegenerationJobActivity({ storyId, status: result.status });

	// Returned verbatim, so the workflow's own result stays a faithful record of
	// what the rewrite did — the job row is for the user, this is for replay and
	// for anyone reading the execution in the Temporal UI.
	return result;
}
