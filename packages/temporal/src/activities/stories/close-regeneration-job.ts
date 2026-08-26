/**
 * Activity: close the Job Hub row a type conversion opened for a body
 * regeneration (Fizzy #2048).
 *
 * The conversion procedure opens the row the moment it starts the workflow, so
 * the user sees the rewrite the instant they click. Something has to close it,
 * and it has to be an ACTIVITY: workflow code is replayed, so a database write
 * there would need `patched()` sentinels and would drag this workflow into
 * replay-validation CI for a purely observational write. The watchdog would
 * otherwise stamp every regeneration "Timed out — no progress reported" a few
 * minutes after it actually succeeded.
 *
 * The mapping is deliberately strict: ONLY `regenerated` closes COMPLETED,
 * because only `regenerated` wrote anything. Every other outcome left the prior
 * body in place, which is the safe result but not the one the user asked for —
 * closing those green would tell them their body was rewritten when it was not.
 */

import { jobComplete, jobFail } from "../lib/job-progress";
import type { RegenerateBodyForKindStatus } from "./regenerate-body-for-kind";

/**
 * The activity's five typed outcomes, plus the one the activity cannot report on
 * its own: it threw, and the workflow is closing the row on its behalf.
 */
export type CloseRegenerationJobStatus =
	| RegenerateBodyForKindStatus
	| "workflow_error";

export interface CloseRegenerationJobInput {
	/** The job row's `sourceId` — one work item, one row. */
	storyId: string;
	status: CloseRegenerationJobStatus;
}

/**
 * Rendered VERBATIM in the Job Hub, so each one says what happened to the body
 * and not what happened in the code. Every non-success message states that the
 * previous body was kept, because that is the fact the user needs: nothing was
 * lost, and converting again is safe.
 */
const FAILURE_MESSAGE: Record<
	Exclude<CloseRegenerationJobStatus, "regenerated">,
	string
> = {
	story_not_found:
		"The work item no longer exists, so its body was not rewritten.",
	model_did_not_run:
		"No template ran for the new type, so the previous body was kept.",
	below_content_floor:
		"The rewrite came back empty or far shorter than the original, so the previous body was kept.",
	stale: "A newer change to this work item arrived first, so the rewrite was discarded and the previous body was kept.",
	workflow_error:
		"The rewrite could not be completed, so the previous body was kept.",
};

export async function closeRegenerationJobActivity(
	input: CloseRegenerationJobInput,
): Promise<void> {
	if (input.status === "regenerated") {
		await jobComplete({ sourceId: input.storyId });
		return;
	}

	await jobFail(FAILURE_MESSAGE[input.status], {
		sourceId: input.storyId,
		// The activity's own status word, so a support query can group refusals
		// by cause without parsing the sentence above.
		errorClass: input.status,
	});
}
