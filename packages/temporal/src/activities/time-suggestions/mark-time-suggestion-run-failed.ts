/**
 * The failure marker for a time-suggestion run.
 *
 * A separate activity from the steps that can fail, behind its own short
 * timeout in the workflow, so a failing run does not stay GENERATING. The
 * write is a compare-and-set on GENERATING: a run already finished or
 * reclaimed is left alone, which is a normal outcome and not an error.
 */

import { failTimeSuggestionRun } from "@repo/database";
import { logger } from "@repo/logs";

export interface MarkTimeSuggestionRunFailedInput {
	runId: string;
	organizationId: string;
	userId: string;
	message: string;
}

export async function markTimeSuggestionRunFailedActivity(
	input: MarkTimeSuggestionRunFailedInput,
): Promise<void> {
	const changed = await failTimeSuggestionRun({
		runId: input.runId,
		organizationId: input.organizationId,
		userId: input.userId,
		error: input.message,
	});
	if (!changed) {
		logger.info("[TimeSuggestions] failure marker skipped", {
			runId: input.runId,
			reason: "run no longer generating",
		});
	}
}
