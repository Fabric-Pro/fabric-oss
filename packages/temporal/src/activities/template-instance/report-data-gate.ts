/**
 * Workflow-safe (pure, no side-effecting imports) helpers for deciding whether
 * a report run gathered usable data. Safe to import from the Temporal workflow
 * — keep this file free of @repo/ai, @repo/database, logger, Buffer, Date, etc.
 */

export type AgenticDataSourceResult = {
	sourceId: string;
	sourceType: "agentic";
	provider: string;
	data: unknown;
	recordCount: number;
};

/**
 * Is a value "contentful" (real payload vs empty wrapper / falsy metadata)?
 * Non-empty array, or object with at least one contentful value, or a TRUTHY
 * primitive. Falsy primitives (0, false, "") are metadata, not content, so
 * `{ results: [], total: 0 }` is NOT contentful (Codex finding 4). Recurses
 * so nested wrappers like `{ data: { items: [] } }` are also empty.
 */
function isContentful(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value === "object") {
		return Object.values(value as Record<string, unknown>).some(
			isContentful,
		);
	}
	return Boolean(value);
}

/**
 * Count usable records in one agentic gathered-data value. Arrays count by
 * length; null/undefined → 0; an object counts as 1 only if it is contentful
 * (see `isContentful`), so wrapper-empty objects (`{}`, `{items:[]}`,
 * `{results:[],total:0}`) → 0; a truthy primitive → 1, a falsy primitive → 0.
 */
export function countAgenticRecords(data: unknown): number {
	if (Array.isArray(data)) {
		return data.length;
	}
	if (data === null || data === undefined) {
		return 0;
	}
	if (typeof data === "object") {
		return isContentful(data) ? 1 : 0;
	}
	return data ? 1 : 0;
}

/**
 * Map the agentic loop's `gatheredData` (keyed by tool name) into data-source
 * results + a usable-record total, using `countAgenticRecords`. Pure: this is
 * the exact gate input the workflow computes, extracted so the failure mode
 * (partial salvage with non-empty data but zero usable records) is testable
 * without a full Temporal workflow harness (Codex finding 3).
 */
export function mapAgenticGatheredData(
	gatheredData: Record<string, unknown>,
	opts: { toolToSourceId: Record<string, string>; provider: string },
): { results: AgenticDataSourceResult[]; totalRecords: number } {
	const results: AgenticDataSourceResult[] = [];
	let totalRecords = 0;
	for (const [toolName, data] of Object.entries(gatheredData)) {
		// `_`-prefixed keys (e.g. `_coverage`) are gathering metadata, not
		// records: forward them to the report prompt but never let them count
		// toward the no-usable-data gate.
		const recordCount = toolName.startsWith("_")
			? 0
			: countAgenticRecords(data);
		const sourceId = opts.toolToSourceId[toolName] || `agentic_${toolName}`;
		results.push({
			sourceId,
			sourceType: "agentic",
			provider: opts.provider,
			data,
			recordCount,
		});
		totalRecords += recordCount;
	}
	return { results, totalRecords };
}

/**
 * A run has no usable data when the agentic loop returned partial AND zero
 * usable records were gathered. A *complete* run with zero records is a
 * legitimately empty board and still renders a "no data" report.
 */
export function hasNoUsableData(
	isPartial: boolean,
	usableRecords: number,
): boolean {
	return isPartial && usableRecords === 0;
}
