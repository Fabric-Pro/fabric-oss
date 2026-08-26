import {
	type ContextSourceReference,
	type ContextSummaryStats,
	completeContextSummary,
} from "@repo/database";

/**
 * Persist a successful summary (flips the row COMPLETED and supersedes the
 * project's prior COMPLETED summary in one transaction — see
 * `completeContextSummary`). Writes the TRUE watermark, the reference registry,
 * the engine version, and the observability stats produced by generation.
 */
export async function persistSummaryActivity(input: {
	summaryId: string;
	content: string;
	tokenCount: number;
	model: string;
	coveredContextCount: number;
	coveredThrough: string;
	references: ContextSourceReference[];
	stats: ContextSummaryStats;
	spentInputTokens: number;
	spentOutputTokens: number;
	spentCostMicroUsd: number;
}): Promise<void> {
	await completeContextSummary({
		id: input.summaryId,
		content: input.content,
		tokenCount: input.tokenCount,
		coveredContextCount: input.coveredContextCount,
		coveredThrough: new Date(input.coveredThrough),
		model: input.model,
		references: input.references,
		stats: input.stats,
		spentInputTokens: input.spentInputTokens,
		spentOutputTokens: input.spentOutputTokens,
		spentCostMicroUsd: BigInt(
			Math.max(0, Math.round(input.spentCostMicroUsd)),
		),
	});
}
