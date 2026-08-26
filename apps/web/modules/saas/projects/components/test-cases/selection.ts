/**
 * Bulk-selection state transitions for the Cases list.
 *
 * Two modes share one set of checkboxes:
 *  - **ids** — the reader ticked specific rows; `selected` holds them.
 *  - **all matching** — the reader escalated to "every row these filters match",
 *    including rows this browser never loaded. `selected` is EMPTY in this mode;
 *    every loaded row renders checked from the escalation flag alone, and the
 *    mutation is sent as a predicate rather than a list of ids.
 *
 * That second mode is why unticking needs care. `selected` being empty meant a
 * plain toggle *added* the row the reader just unticked — leaving it as the only
 * selection, silently unchecking every other loaded row, and pointing the next
 * Delete at exactly the wrong set. Unticking while escalated has to start from
 * "every loaded row" and drop the escalation, because the selection model has no
 * way to say "everything matching except this one".
 *
 * Pure so the transitions are unit-testable without rendering the list.
 */

export interface SelectionState {
	selected: Set<string>;
	selectAllMatching: boolean;
}

/** Tick or untick one row. */
export function toggleSelection(
	state: SelectionState,
	input: { id: string; visibleIds: string[] },
): SelectionState {
	const base = state.selectAllMatching
		? new Set(input.visibleIds)
		: new Set(state.selected);

	if (base.has(input.id)) {
		base.delete(input.id);
	} else {
		base.add(input.id);
	}

	// Narrowing or extending by hand always describes a concrete set of rows,
	// never "everything matching" — so the escalation cannot survive it.
	return { selected: base, selectAllMatching: false };
}

/** The header checkbox: tick or untick every loaded row. */
export function toggleAllVisible(input: {
	visibleIds: string[];
	checked: boolean;
}): SelectionState {
	return {
		selected: input.checked ? new Set(input.visibleIds) : new Set(),
		selectAllMatching: false,
	};
}

/** Escalate the ticked rows to "every row the current filters match". */
export function escalateToAllMatching(): SelectionState {
	// The ids are dropped deliberately: the mutation travels as a predicate, and
	// keeping a stale id list around invites the two to disagree.
	return { selected: new Set(), selectAllMatching: true };
}

/** Drop everything. */
export function clearSelection(): SelectionState {
	return { selected: new Set(), selectAllMatching: false };
}

/**
 * Does the header checkbox read as fully checked? True while escalated — every
 * loaded row is checked then, even though `selected` is empty, and showing an
 * indeterminate header above a page of ticked rows reads as a bug.
 */
export function isAllVisibleSelected(
	state: SelectionState,
	visibleIds: string[],
): boolean {
	if (state.selectAllMatching) {
		return true;
	}
	return (
		visibleIds.length > 0 &&
		visibleIds.every((id) => state.selected.has(id))
	);
}
