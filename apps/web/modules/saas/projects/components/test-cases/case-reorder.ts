import type { SortDirection, SortKey } from "./constants";

/**
 * When manual reordering of the project's cases is coherent.
 *
 * `testCases.reorder` shipped with no UI, and the register wrongly called it
 * redundant. It is not: the list's sort keys include `order`, so a reader can sort
 * by manual order and has no way to set it — a read path for an order nobody can
 * write.
 *
 * The reason it stayed unbuilt is real, though. `TestCase.order` is a **single
 * global column per project**, while this list is offset-paginated and filterable
 * on nine dimensions. Drag-and-drop over an arbitrary view of it is not a
 * reordering, it is a guess:
 *
 * - **Sorted by anything else** — dragging a row would either fight the active
 *   sort (the row snaps back on the next fetch) or silently rewrite `order` while
 *   the reader watches a list ordered by priority. Neither is a reorder.
 * - **Descending** — the writer numbers rows top-to-bottom from 0. Under `desc`
 *   that inverts the reader's intent, so the row lands at the opposite end.
 * - **Filtered** — the visible rows are a subset. Renumbering them 0..n-1
 *   assigns order values that collide with the hidden rows, so the unfiltered
 *   list comes back interleaved in a way nobody asked for.
 * - **Partially loaded** — same collision, one page down: renumbering the loaded
 *   prefix overwrites order values the unloaded tail still holds.
 *
 * So all four must hold. This is deliberately a pure predicate rather than a pile
 * of `&&` at the call site: each clause has a distinct reason a reader needs, and
 * the reason is what the UI shows when dragging is unavailable.
 */
export type ReorderBlocker =
	| "SORT"
	| "DIRECTION"
	| "FILTERED"
	| "NOT_ALL_LOADED";

export interface ReorderGateInput {
	sort: SortKey;
	direction: SortDirection;
	hasActiveFilters: boolean;
	/** True while the infinite query has pages it has not fetched. */
	hasNextPage: boolean;
	/** Reordering is a write, so a reader without edit rights gets no handles. */
	canEdit: boolean;
}

/**
 * The first reason THE VIEW cannot be dragged, or null when it can.
 *
 * Ordered by what the reader should fix first: the sort is the precondition that
 * makes the whole idea meaningful, so it is named before the narrower ones.
 * Returning ONE blocker rather than a list keeps the message actionable — a
 * reader told four things at once fixes none of them.
 *
 * Deliberately knows nothing about permission. Permission is not a reason to
 * explain: a viewer is not being denied a control they can see, because the
 * handles are never rendered for them. Folding `canEdit` in here would make this
 * answer "the sort is wrong" to someone whose sort is fine, which is the kind of
 * false explanation that sends a person to change a setting that was never the
 * problem.
 */
export function reorderBlocker(
	input: Omit<ReorderGateInput, "canEdit">,
): ReorderBlocker | null {
	if (input.sort !== "order") {
		return "SORT";
	}
	if (input.direction !== "asc") {
		return "DIRECTION";
	}
	if (input.hasActiveFilters) {
		return "FILTERED";
	}
	if (input.hasNextPage) {
		return "NOT_ALL_LOADED";
	}
	return null;
}

/** Whether drag handles should render at all: the view allows it AND it is a write this reader may make. */
export function canReorderCases(input: ReorderGateInput): boolean {
	return input.canEdit && reorderBlocker(input) === null;
}

/**
 * The `{ id, order }` payload for a dragged list.
 *
 * Renumbers the WHOLE visible list from 0 rather than only the moved row: two
 * cases can share an `order` today (nothing has ever written it), so nudging one
 * value would leave the tie unresolved and the list would settle differently on
 * the next read. Only ever called when {@link canReorderCases} holds, so "the
 * whole visible list" is the whole list.
 */
export function buildReorderPayload(
	orderedIds: readonly string[],
): { id: string; order: number }[] {
	return orderedIds.map((id, index) => ({ id, order: index }));
}
