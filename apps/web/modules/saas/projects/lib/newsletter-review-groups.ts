import {
	groupHighlightsByRelease,
	type ReleaseHighlight,
} from "@repo/utils/group-highlights";

/**
 * The release groups the email will show, for the review dialog.
 *
 * The email (and the in-app view) regroup highlights with
 * `groupHighlightsByRelease`, so the reviewer's order only holds within a
 * release. The dialog shows exactly that: the same grouping, run over the
 * highlights in the reviewer's current order, and reordering within a group.
 */
export interface ReviewHighlightGroup {
	key: string;
	tag: string | null;
	repoFullName: string | null;
	/** Original indexes into `content.highlights`, in displayed order. */
	indexes: number[];
}

export function groupReviewHighlights(
	highlights: readonly ReleaseHighlight[],
	order: readonly number[],
): ReviewHighlightGroup[] {
	// `groupHighlightsByRelease` returns the very item objects it was given,
	// so each one's original index is recovered by identity.
	const indexByItem = new Map<ReleaseHighlight, number>();
	const ordered: ReleaseHighlight[] = [];
	for (const index of order) {
		const highlight = highlights[index];
		if (highlight && !indexByItem.has(highlight)) {
			indexByItem.set(highlight, index);
			ordered.push(highlight);
		}
	}
	return groupHighlightsByRelease(ordered).map((group) => ({
		key: JSON.stringify([group.repoFullName, group.tag]),
		tag: group.tag,
		repoFullName: group.repoFullName,
		indexes: group.items.flatMap((item) => {
			const index = indexByItem.get(item);
			return index === undefined ? [] : [index];
		}),
	}));
}

/**
 * Move `activeIndex` to where `overIndex` is, within one group, and write the
 * result back into the flat `order`: the positions the group's members hold
 * in `order` take the group's new sequence; every other entry stays put. A
 * drop on a highlight outside the group, or a move onto itself, changes
 * nothing.
 */
export function moveWithinGroup(
	order: readonly number[],
	groupIndexes: readonly number[],
	activeIndex: number,
	overIndex: number,
): number[] {
	const from = groupIndexes.indexOf(activeIndex);
	const to = groupIndexes.indexOf(overIndex);
	if (from < 0 || to < 0 || from === to) {
		return [...order];
	}
	const sequence = [...groupIndexes];
	sequence.splice(from, 1);
	sequence.splice(to, 0, activeIndex);
	const members = new Set(groupIndexes);
	if (order.filter((index) => members.has(index)).length !== members.size) {
		return [...order];
	}
	let next = 0;
	return order.map((index) =>
		members.has(index) ? sequence[next++] : index,
	);
}
