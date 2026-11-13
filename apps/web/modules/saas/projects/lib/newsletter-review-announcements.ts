interface DragItem {
	id: string | number;
}

interface ReviewDrag {
	active: DragItem;
	over: DragItem | null;
}

/** The shape dnd-kit's `accessibility.announcements` takes. */
interface ReviewDragAnnouncements {
	onDragStart(drag: Pick<ReviewDrag, "active">): string | undefined;
	onDragOver(drag: ReviewDrag): string | undefined;
	onDragEnd(drag: ReviewDrag): string | undefined;
	onDragCancel(drag: Pick<ReviewDrag, "active">): string | undefined;
}

/**
 * Screen-reader wording for reordering highlights in the review dialog.
 * dnd-kit's default reads the sortable ids aloud; these name the highlight.
 * An id with no title announces nothing.
 */
export function reviewDragAnnouncements(
	titleOf: (sortableId: string) => string | undefined,
): ReviewDragAnnouncements {
	const title = (item: DragItem | null) =>
		item ? titleOf(String(item.id)) : undefined;
	return {
		onDragStart({ active }) {
			const moved = title(active);
			return moved ? `Picked up ${moved}.` : undefined;
		},
		onDragOver({ active, over }) {
			const moved = title(active);
			const target = title(over);
			if (!moved || !target || active.id === over?.id) {
				return undefined;
			}
			return `${moved} is over ${target}.`;
		},
		onDragEnd({ active, over }) {
			const moved = title(active);
			if (!moved) {
				return undefined;
			}
			const target = title(over);
			return target && active.id !== over?.id
				? `${moved} was moved to the place of ${target}.`
				: `${moved} was put back in its place.`;
		},
		onDragCancel({ active }) {
			const moved = title(active);
			return moved
				? `Reordering cancelled. ${moved} is back in its place.`
				: undefined;
		},
	};
}
