import {
	type ContextSummaryTrigger,
	createPendingContextSummary,
	type SourceSelection,
	type SummaryTenancy,
} from "@repo/database";

/**
 * Create the PENDING summary row a run fills in, capturing `snapshotThrough` HERE
 * (activity side = real wall-clock) as the run's stable high-water mark. The
 * workflow threads it to the fetch/generate/persist activities so every step
 * bounds itself to the same point-in-time; context created after it is deferred
 * to the next run. This is NOT the coverage watermark — `coveredThrough` is set
 * at completion to the latest source actually folded (see `generateSummaryActivity`).
 */
export async function createPendingSummaryActivity(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	trigger: ContextSummaryTrigger;
	triggeredByUserId?: string | null;
	sourceSelection?: SourceSelection;
}): Promise<{ summaryId: string; snapshotThrough: string }> {
	const snapshotThrough = new Date();
	const row = await createPendingContextSummary({
		projectId: input.projectId,
		tenancy: input.tenancy,
		trigger: input.trigger,
		triggeredByUserId: input.triggeredByUserId ?? null,
		snapshotThrough,
		sourceSelection: input.sourceSelection,
	});
	return {
		summaryId: row.id,
		snapshotThrough: snapshotThrough.toISOString(),
	};
}
