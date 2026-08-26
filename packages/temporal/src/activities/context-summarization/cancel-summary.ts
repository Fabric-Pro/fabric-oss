import { cancelContextSummary } from "@repo/database";

/**
 * Mark a still-running summary CANCELLED after the workflow is cancelled. Only a
 * PENDING/GENERATING row flips (see `cancelContextSummary`), so a cancel that races
 * completion never clobbers a good summary. Runs in the workflow's non-cancellable
 * scope so it always completes.
 */
export async function cancelSummaryActivity(input: {
	summaryId: string;
}): Promise<void> {
	await cancelContextSummary(input.summaryId);
}
