export type StorySemanticActivityRow = {
	id: string;
	createdAt: Date;
	lastEditedAt: Date | null;
};

export type StorySemanticActivityDirection = "asc" | "desc";

/**
 * Creation is the only truthful activity for a story that has never had a
 * recorded semantic edit. Operational `updatedAt` writes are intentionally
 * excluded.
 */
export function storySemanticActivityAt(story: {
	createdAt: Date;
	/** Optional so UI row types, whose field is optional, can pass through. */
	lastEditedAt?: Date | null;
}): Date {
	return story.lastEditedAt ?? story.createdAt;
}

/**
 * Return a deterministically ordered copy. The id tie-break makes slicing and
 * pagination stable when multiple rows share the same activity timestamp.
 */
export function orderStoriesBySemanticActivity<
	T extends StorySemanticActivityRow,
>(
	stories: readonly T[],
	direction: StorySemanticActivityDirection = "desc",
): T[] {
	const multiplier = direction === "desc" ? -1 : 1;
	return [...stories].sort((a, b) => {
		const timeDifference =
			storySemanticActivityAt(a).getTime() -
			storySemanticActivityAt(b).getTime();
		return timeDifference === 0
			? a.id.localeCompare(b.id)
			: timeDifference * multiplier;
	});
}
