import type { RoadmapFilters } from "../lib/roadmap-filters";

/**
 * Compute the state patch for removing a tag filter value. Resets `tagsLogic`
 * to its "OR" default whenever fewer than 2 tags remain, so nuqs'
 * `clearOnDefault` strips a stale `?tagsLogic=AND` from the URL.
 */
export function computeTagsRemovalPatch(
	current: string[],
	value: string | undefined,
	_currentLogic: RoadmapFilters["tagsLogic"],
): Partial<RoadmapFilters> {
	const nextTags = value ? current.filter((t) => t !== value) : [];
	return {
		tags: nextTags,
		...(nextTags.length < 2 ? { tagsLogic: "OR" as const } : {}),
	};
}
