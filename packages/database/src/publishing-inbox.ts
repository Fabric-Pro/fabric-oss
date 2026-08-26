/**
 * Inbox section composition for Publishing Suite 1D (Fizzy #2265).
 *
 * Pure and synchronous, over the array `listPublishingTopics` already returns.
 * There is deliberately no database query behind this: the rows are all in
 * memory already, a project holds tens of topics, and a WHERE/LIMIT would buy
 * an index and a round trip to save nothing.
 */

/** The minimum shape the partition needs. Structural on purpose, so this module
 *  does not depend on the full list-item type and its test needs no fixtures. */
export interface InboxTopicShape {
	status: string;
	isSnoozed: boolean;
	updatedAt: Date;
}

const RECENTLY_MODIFIED_STATUSES = new Set(["IN_PROGRESS", "SELECTED"]);

export function composeInboxSections<T extends InboxTopicShape>(
	items: readonly T[],
	opts: { maxRecent?: number } = {},
): { recentlyModified: T[]; recentlyModifiedTotal: number; suggested: T[] } {
	const maxRecent = opts.maxRecent ?? 3;
	const live = items.filter((t) => !t.isSnoozed);

	// FR2 names `updatedAt`, which is NOT the key the array arrives sorted by,
	// and the section is capped — so this one genuinely must sort. A cap taken
	// over an array ordered by something else would pick the wrong three.
	const recent = live
		.filter((t) => RECENTLY_MODIFIED_STATUSES.has(t.status))
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

	// Suggested FILTERS and does not sort. The incoming array is already in 1B's
	// per-viewer tier order (contributed, then role-match, then the rest) with
	// createdAt desc inside each tier. Re-sorting globally by createdAt would
	// flatten those tiers and switch personalization off in what is becoming the
	// default view — a change to 1B, which 1D puts out of scope.
	const suggested = live.filter((t) => t.status === "SUGGESTION");

	return {
		recentlyModified: recent.slice(0, maxRecent),
		recentlyModifiedTotal: recent.length,
		suggested,
	};
}

/**
 * Is a topic still snoozed at `now`? (1D, Fizzy #2265)
 *
 * The boundary is deliberately EXCLUSIVE: a snooze whose deadline has exactly
 * arrived counts as ELAPSED, so the topic re-surfaces on the instant it is due
 * rather than one tick later. Pure, and `now` is a parameter, because this is
 * the only way the boundary itself can be tested — a database test cannot
 * control the clock the query reads.
 */
export function isTopicSnoozed(snoozedUntil: Date | null, now: Date): boolean {
	return snoozedUntil !== null && snoozedUntil > now;
}
