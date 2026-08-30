/**
 * The failure marker for a Planning & Analysis attempt (#1851, Phase 2A-2).
 *
 * A separate activity from the generator on purpose. The generator commits its
 * own success, but by definition it cannot be trusted to record its own
 * failure — the reason it failed may be the very thing that stops it writing.
 * The workflow owns this call, behind its own short-timeout proxy so a failing
 * run does not sit on GENERATING for another generation budget.
 *
 * The write itself is a compare-and-set on `status = 'GENERATING'` scoped by
 * `{ id, projectId }`, so a marker arriving after a deadline sweep already
 * reclaimed the attempt changes nothing. That is a normal outcome and NOT an
 * error: throwing here would make the workflow's last-resort catch fire and
 * report a crash where there was only a race that the database already settled.
 */

import { failPlanningAnalysis } from "@repo/database";
import { logger } from "@repo/logs";

export interface MarkPlanningAnalysisFailedInput {
	analysisId: string;
	projectId: string;
	message: string;
}

export async function markPlanningAnalysisFailedActivity(
	input: MarkPlanningAnalysisFailedInput,
): Promise<void> {
	const { persisted } = await failPlanningAnalysis({
		id: input.analysisId,
		projectId: input.projectId,
		error: input.message,
	});

	if (!persisted) {
		logger.info(
			"[publishing-planning] failure marker skipped; attempt was already terminal",
			{ analysisId: input.analysisId, projectId: input.projectId },
		);
	}
}
