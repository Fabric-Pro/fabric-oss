/**
 * The failure marker for a refinement run (Fizzy #1851 follow-up).
 *
 * A separate activity from the refiner, on the same reasoning its generation
 * siblings use: the refiner commits its own success, but by definition it cannot
 * be trusted to record its own failure — the reason it failed may be the very
 * thing that stops it writing. The workflow owns this call, behind its own
 * short-timeout proxy so a failing run does not sit on GENERATING for another
 * generation budget.
 *
 * The write is a compare-and-set on `refinementRunId` AND
 * `refinementStatus = 'GENERATING'`, so a marker arriving after the slot was
 * reclaimed, rejected or re-claimed by a newer run changes nothing. That is a
 * normal outcome and NOT an error: throwing here would make the workflow's
 * last-resort catch fire and report a crash where there was only a race the
 * database already settled.
 */

import {
	type DraftPostType,
	failRefinement,
	logDraftRefusal,
} from "@repo/database";

export interface MarkRefinementFailedInput {
	runId: string;
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	message: string;
}

export async function markRefinementFailedActivity(
	input: MarkRefinementFailedInput,
): Promise<void> {
	const commit = await failRefinement({
		topicId: input.topicId,
		projectId: input.projectId,
		postType: input.postType,
		runId: input.runId,
		error: input.message,
	});

	if (!commit.persisted) {
		// Why the marker was skipped, not just that it was. A superseded run is
		// routine; an archived project is somebody's action.
		logDraftRefusal(
			"[publishing-refine] failure marker skipped",
			commit.reason,
			{
				runId: input.runId,
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
			},
		);
	}
}
