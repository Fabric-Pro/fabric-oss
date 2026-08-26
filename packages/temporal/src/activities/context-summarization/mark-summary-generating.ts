import { markContextSummaryGenerating } from "@repo/database";

/** Flip the summary row PENDING → GENERATING so its status is observable. */
export async function markSummaryGeneratingActivity(input: {
	summaryId: string;
}): Promise<void> {
	await markContextSummaryGenerating(input.summaryId);
}
