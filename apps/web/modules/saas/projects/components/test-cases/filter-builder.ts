import { ALL, type TestCasesFilters } from "./use-test-cases-view";

/**
 * Which filters the toolbar offers, and which of them are on screen right now.
 *
 * Six always-rendered dropdowns is a wall of "All …" that says nothing: the row
 * is at its widest when nothing is filtered, and a reader scanning it cannot
 * tell at a glance which of the six are actually narrowing the list. So a filter
 * is on screen only once it is doing something — either it has a value, or
 * somebody explicitly added it from the menu and is about to give it one.
 *
 * Kept pure and separate from the toolbar because the interesting part is the
 * rules, not the markup: a set filter can never be hidden (that would strand a
 * predicate the reader cannot see, let alone remove), and the row must not
 * reshuffle as filters come and go.
 */

/**
 * The filters that can be ADDED from the menu, in the order they appear in the
 * row. Iterating this — rather than the reveal set — is what keeps the order
 * stable: adding Priority after Tag puts it before Tag, where it was last time.
 *
 * `planId` is deliberately absent. There is no plan picker in this toolbar; the
 * filter arrives from the Plans tab as a deep link, so offering "Plan" in the
 * menu would open a control the reader cannot fill in. It still renders when
 * set — see `visibleFilters`.
 */
export const BUILDABLE_FILTERS = [
	"priority",
	"automationStatus",
	"currentResult",
	"externalLinked",
	"linkedStoryId",
	"tag",
] as const;

export type BuildableFilter = (typeof BUILDABLE_FILTERS)[number];

/** Is this filter currently narrowing the list? */
export function isFilterSet(
	filters: TestCasesFilters,
	key: BuildableFilter,
): boolean {
	switch (key) {
		case "priority":
			return filters.priority !== ALL;
		case "automationStatus":
			return filters.automationStatus !== ALL;
		case "currentResult":
			return filters.currentResult !== ALL;
		case "externalLinked":
			return filters.externalLinked !== ALL;
		case "linkedStoryId":
			return filters.linkedStoryId !== null;
		case "tag":
			return (filters.tag ?? "").trim() !== "";
		default: {
			const exhaustive: never = key;
			return exhaustive;
		}
	}
}

/**
 * The filters to render, in row order: everything set, plus everything the
 * reader added and has not filled in yet.
 *
 * A set filter is included whether or not it was ever "added" — filters also
 * arrive from a pasted link or a saved view, and one that applied invisibly
 * would leave a reader staring at a short list with no way to widen it.
 */
export function visibleFilters(
	filters: TestCasesFilters,
	revealed: ReadonlySet<BuildableFilter>,
): BuildableFilter[] {
	return BUILDABLE_FILTERS.filter(
		(key) => revealed.has(key) || isFilterSet(filters, key),
	);
}

/** What is left for the menu to offer. */
export function addableFilters(
	visible: readonly BuildableFilter[],
): BuildableFilter[] {
	return BUILDABLE_FILTERS.filter((key) => !visible.includes(key));
}

/**
 * The short name each filter goes by — in the menu that adds it, and on the
 * control that removes it. Kept beside the filter list rather than in the
 * toolbar so a new filter cannot be offered without a name to offer it under.
 */
export const FILTER_LABEL_KEY: Record<BuildableFilter, string> = {
	priority: "filters.priorityLabel",
	automationStatus: "filters.automationLabel",
	currentResult: "filters.resultLabel",
	externalLinked: "filters.linkedLabel",
	linkedStoryId: "filters.featureLabel",
	tag: "filters.tagLabel",
};
