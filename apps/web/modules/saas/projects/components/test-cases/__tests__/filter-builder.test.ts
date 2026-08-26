import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// `use-test-cases-view` pulls in the oRPC client for its query key; nothing
// under test here touches it.
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

import {
	addableFilters,
	BUILDABLE_FILTERS,
	type BuildableFilter,
	FILTER_LABEL_KEY,
	isFilterSet,
	visibleFilters,
} from "../filter-builder";
import { ALL, type TestCasesFilters } from "../use-test-cases-view";

const NONE: TestCasesFilters = {
	search: "",
	state: ALL,
	priority: ALL,
	tag: null,
	linkedStoryId: null,
	planId: null,
	automationStatus: ALL,
	currentResult: ALL,
	externalLinked: ALL,
};

const nothingRevealed = new Set<BuildableFilter>();

describe("isFilterSet", () => {
	it("is false for every filter on an unfiltered view", () => {
		for (const key of BUILDABLE_FILTERS) {
			expect(isFilterSet(NONE, key), key).toBe(false);
		}
	});

	it("reads the ALL sentinel as unset, not as a value", () => {
		expect(isFilterSet({ ...NONE, priority: "HIGH" }, "priority")).toBe(
			true,
		);
		expect(isFilterSet({ ...NONE, priority: ALL }, "priority")).toBe(false);
	});

	/**
	 * `externalLinked: false` is a real predicate — "cases with no linked work
	 * item" — and a falsiness check would drop it, hiding a control that IS
	 * narrowing the list.
	 */
	it("treats a false boolean filter as set", () => {
		expect(
			isFilterSet({ ...NONE, externalLinked: false }, "externalLinked"),
		).toBe(true);
	});

	it("does not count whitespace as a tag", () => {
		expect(isFilterSet({ ...NONE, tag: "   " }, "tag")).toBe(false);
		expect(isFilterSet({ ...NONE, tag: "smoke" }, "tag")).toBe(true);
	});
});

describe("visibleFilters", () => {
	it("shows nothing on a clean view", () => {
		expect(visibleFilters(NONE, nothingRevealed)).toEqual([]);
	});

	it("shows a filter the reader added but has not filled in", () => {
		expect(visibleFilters(NONE, new Set<BuildableFilter>(["tag"]))).toEqual(
			["tag"],
		);
	});

	/**
	 * The rule that keeps the builder honest. Filters also arrive from a pasted
	 * link or a saved view, where nobody clicked "Add filter" — a set filter that
	 * stayed hidden would narrow the list with no visible cause and no way to
	 * widen it again.
	 */
	it("shows a set filter that was never added", () => {
		expect(
			visibleFilters({ ...NONE, priority: "HIGH" }, nothingRevealed),
		).toEqual(["priority"]);
	});

	it("keeps row order stable regardless of the order filters were added", () => {
		const lateFirst = new Set<BuildableFilter>(["tag", "priority"]);
		const earlyFirst = new Set<BuildableFilter>(["priority", "tag"]);
		expect(visibleFilters(NONE, lateFirst)).toEqual(["priority", "tag"]);
		expect(visibleFilters(NONE, earlyFirst)).toEqual(["priority", "tag"]);
	});

	it("does not double-count a filter that is both added and set", () => {
		expect(
			visibleFilters(
				{ ...NONE, tag: "smoke" },
				new Set<BuildableFilter>(["tag"]),
			),
		).toEqual(["tag"]);
	});
});

describe("addableFilters", () => {
	it("offers everything when the row is empty", () => {
		expect(addableFilters([])).toEqual([...BUILDABLE_FILTERS]);
	});

	it("never offers a filter already on screen", () => {
		expect(addableFilters(["priority", "tag"])).not.toContain("priority");
		expect(addableFilters(["priority", "tag"])).not.toContain("tag");
	});

	it("is empty once every filter is shown", () => {
		expect(addableFilters(BUILDABLE_FILTERS)).toEqual([]);
	});
});

/**
 * `planId` has no picker in this toolbar — it is a deep link from the Plans tab.
 * Offering it in the menu would open a control with nothing to choose from.
 */
describe("the plan filter", () => {
	it("is not offered by the menu", () => {
		expect(BUILDABLE_FILTERS).not.toContain("planId" as BuildableFilter);
	});
});

/**
 * A wiring guard, not a behaviour test — the same shape as `display-wiring`.
 *
 * `BUILDABLE_FILTERS` is a list; the toolbar renders each entry by hand. Adding
 * a seventh and forgetting its control is not a type error: the menu would
 * offer it, the reader would pick it, and nothing would appear. The failure
 * looks like a dead menu item rather than like a mistake, so nobody reports it
 * as one.
 */
describe("every buildable filter is rendered by the toolbar", () => {
	const TOOLBAR = readFileSync(
		path.resolve(__dirname, "../CasesToolbar.tsx"),
		"utf8",
	);

	it.each(BUILDABLE_FILTERS)("%s has a control in the row", (key) => {
		expect(TOOLBAR).toContain(`shownFilters.includes("${key}")`);
	});

	it.each(BUILDABLE_FILTERS)("%s can be removed again", (key) => {
		expect(TOOLBAR).toContain(`removeFilter("${key}")`);
	});

	it.each(BUILDABLE_FILTERS)("%s has a name to be listed under", (key) => {
		expect(FILTER_LABEL_KEY[key]).toBeTruthy();
	});
});
