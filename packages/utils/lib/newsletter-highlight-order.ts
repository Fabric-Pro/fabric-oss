/**
 * The one rule for which highlights of a reviewed release-notes send go out,
 * and in what order.
 *
 * A highlight has no id: its index into the send's frozen `content.highlights`
 * is its identity, which is why the reviewer's removals and order are both
 * stored as index lists and the stored array is never reordered.
 *
 * `highlightOrder` is applied first, then removals:
 *  - an order that is not an array of distinct in-range integers is ignored as
 *    a whole, and the natural order is used;
 *  - a valid order may be partial: indexes it leaves out follow it in their
 *    natural order, so a highlight is never lost because the order missed it;
 *  - removed indexes are then dropped; out-of-range removals are ignored.
 */
export function effectiveHighlightIndexes(
	highlightCount: number,
	removedIndexes: readonly number[],
	highlightOrder: unknown,
): number[] {
	const natural = Array.from({ length: highlightCount }, (_, i) => i);
	const listed = isValidOrder(highlightOrder, highlightCount)
		? highlightOrder
		: [];
	const ordered = [...listed, ...natural.filter((i) => !listed.includes(i))];
	const removed = new Set(removedIndexes);
	return ordered.filter((i) => !removed.has(i));
}

/** The highlights to render: the reviewer's order, removed ones dropped. */
export function orderNewsletterHighlights<T>(
	highlights: readonly T[],
	removedIndexes: readonly number[],
	highlightOrder: unknown,
): T[] {
	return effectiveHighlightIndexes(
		highlights.length,
		removedIndexes,
		highlightOrder,
	).map((i) => highlights[i]);
}

function isValidOrder(value: unknown, count: number): value is number[] {
	if (!Array.isArray(value)) {
		return false;
	}
	const seen = new Set<number>();
	for (const entry of value) {
		if (
			typeof entry !== "number" ||
			!Number.isInteger(entry) ||
			entry < 0 ||
			entry >= count ||
			seen.has(entry)
		) {
			return false;
		}
		seen.add(entry);
	}
	return true;
}
