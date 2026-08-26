import {
	type ProjectContextSummary,
	parseSourceSelection,
	parseSummaryReferences,
	parseSummaryStats,
} from "@repo/database";

/**
 * Map a summary row to the serializable "version" DTO used by history, restore,
 * edit, and status responses. Parses the JSON columns and converts the BigInt cost
 * to a plain number (micro-USD fits safely) so oRPC can serialize it.
 */
export function mapSummaryVersion(row: ProjectContextSummary) {
	const stats = parseSummaryStats(row.stats);
	const spentTotalTokens =
		row.spentInputTokens == null && row.spentOutputTokens == null
			? null
			: (row.spentInputTokens ?? 0) + (row.spentOutputTokens ?? 0);
	return {
		id: row.id,
		status: row.status,
		trigger: row.trigger,
		manualEdit: row.manualEdit,
		editedByUserId: row.editedByUserId,
		triggeredByUserId: row.triggeredByUserId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		coveredThrough: row.coveredThrough,
		coveredContextCount: row.coveredContextCount,
		tokenCount: row.tokenCount,
		engineVersion: row.engineVersion,
		model: row.model,
		supersededById: row.supersededById,
		isCurrent: row.status === "COMPLETED" && row.supersededById === null,
		sourceSelection: parseSourceSelection(row.sourceSelection),
		spentInputTokens: row.spentInputTokens,
		spentOutputTokens: row.spentOutputTokens,
		spentTotalTokens,
		spentCostMicroUsd:
			row.spentCostMicroUsd == null
				? null
				: Number(row.spentCostMicroUsd),
		incompleteCoverage: stats?.incompleteCoverage ?? false,
	};
}

/** The version DTO plus its full content + parsed references (single-version reads). */
export function mapSummaryContent(row: ProjectContextSummary) {
	return {
		...mapSummaryVersion(row),
		content: row.content,
		references: parseSummaryReferences(row.references),
	};
}
