export type SecondaryKind =
	| "activity"
	| "source"
	| "size"
	| "points"
	| "tags"
	| "estimate"
	| "track"
	| "flags";

export type SecondaryMeasurement = {
	kind: SecondaryKind;
	width: number;
	compactWidth?: number;
};

/** Select by importance without changing the caller's visual order. */
export function selectSecondaryMetadata(
	items: SecondaryMeasurement[],
	budget: number,
	gap = 8,
	moreWidth = 24,
) {
	const hidden = new Set<SecondaryKind>();
	let compactTags = false;
	const fits = () => {
		const visible = items.filter((item) => !hidden.has(item.kind));
		const hasMore = hidden.size > 0;
		const count = visible.length + Number(hasMore);
		const width = visible.reduce(
			(sum, item) =>
				sum +
				(item.kind === "tags" && compactTags
					? (item.compactWidth ?? item.width)
					: item.width),
			0,
		);
		return (
			width + (hasMore ? moreWidth : 0) + Math.max(0, count - 1) * gap <=
			budget
		);
	};
	// Flags are protected by exclusion from this removal sequence. When they
	// exceed the budget, the renderer clips whole chips and exposes their names.
	for (const tier of [
		["activity"],
		["source"],
		["size", "points"],
		["tags"],
		["estimate"],
		["track"],
	] as const) {
		if (fits()) {
			break;
		}
		for (const kind of tier) {
			const item = items.find((candidate) => candidate.kind === kind);
			if (!item) {
				continue;
			}
			if (kind === "tags" && item.compactWidth !== undefined) {
				compactTags = true;
				if (fits()) {
					break;
				}
			}
			hidden.add(kind);
		}
	}
	// If an oversized high-priority item forced all optional content out,
	// recover smaller items that fit, still preferring the more important ones.
	if (
		!items.some((item) => item.kind !== "flags" && !hidden.has(item.kind))
	) {
		for (const kind of [
			"track",
			"estimate",
			"tags",
			"size",
			"points",
			"source",
			"activity",
		] as const) {
			if (!hidden.has(kind)) {
				continue;
			}
			hidden.delete(kind);
			if (!fits()) {
				hidden.add(kind);
			}
		}
	}
	return { hidden, compactTags };
}
