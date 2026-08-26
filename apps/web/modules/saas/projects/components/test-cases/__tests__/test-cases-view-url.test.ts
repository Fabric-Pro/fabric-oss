import { describe, expect, it, vi } from "vitest";

// The module imports the oRPC client only to build a query key inside the hook;
// the pure URL helpers under test never touch it.
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

import {
	ALL,
	applyViewToParams,
	DEFAULT_VIEW_STATE,
	EMPTY_FILTERS,
	parseViewFromParams,
	shouldResetPage,
	type TestCasesViewState,
} from "../use-test-cases-view";

const parse = (query: string) =>
	parseViewFromParams(new URLSearchParams(query));

const write = (view: TestCasesViewState, base = "") =>
	applyViewToParams(new URLSearchParams(base), view).toString();

describe("parseViewFromParams", () => {
	it("returns the defaults for an empty address bar", () => {
		expect(parse("")).toEqual(DEFAULT_VIEW_STATE);
	});

	it("reads every filter the toolbar can set", () => {
		const view = parse(
			"q=login&state=READY&pri=HIGH&result=FAILED&auto=AUTOMATED&tag=smoke&story=s1&plan=p1&linked=false",
		);
		expect(view.filters).toEqual({
			search: "login",
			state: "READY",
			priority: "HIGH",
			currentResult: "FAILED",
			automationStatus: "AUTOMATED",
			tag: "smoke",
			linkedStoryId: "s1",
			planId: "p1",
			externalLinked: false,
		});
	});

	it("keeps linked=false — 'not linked' is a filter, not an absent one", () => {
		expect(parse("linked=false").filters.externalLinked).toBe(false);
		expect(parse("linked=true").filters.externalLinked).toBe(true);
		expect(parse("").filters.externalLinked).toBe(ALL);
	});

	// These params are hand-editable and arrive from links other people wrote,
	// so a bad value must degrade to the default rather than throw or reach the
	// server as an unknown enum.
	it.each([
		["state=NONSENSE", "state"],
		["pri=URGENT", "priority"],
		["result=EXPLODED", "currentResult"],
		["auto=MAYBE", "automationStatus"],
	])("falls back to unset for a junk %s", (query, key) => {
		expect(parse(query).filters[key as keyof typeof EMPTY_FILTERS]).toBe(
			ALL,
		);
	});

	it("falls back to the default sort and its natural direction", () => {
		expect(parse("sort=colour")).toMatchObject({
			sort: "order",
			direction: "asc",
		});
		// A known key with no direction takes that key's own default, not asc.
		expect(parse("sort=priority")).toMatchObject({
			sort: "priority",
			direction: "desc",
		});
	});

	it("rejects a page below one and a page size the server would refuse", () => {
		expect(parse("page=0").page).toBe(1);
		expect(parse("page=-3").page).toBe(1);
		expect(parse("page=abc").page).toBe(1);
		// 500 is over the procedure's limit cap; falling back beats rendering an
		// empty table with no visible cause.
		expect(parse("size=500").pageSize).toBe(DEFAULT_VIEW_STATE.pageSize);
		expect(parse("size=25").pageSize).toBe(25);
	});
});

describe("applyViewToParams", () => {
	it("writes nothing at all for the default view", () => {
		expect(write(DEFAULT_VIEW_STATE)).toBe("");
	});

	it("round-trips a fully-specified view", () => {
		const view: TestCasesViewState = {
			segment: "plans",
			filters: {
				...EMPTY_FILTERS,
				search: "login",
				state: "READY",
				currentResult: "FAILED",
				externalLinked: false,
			},
			sort: "title",
			direction: "desc",
			page: 4,
			pageSize: 25,
		};
		expect(parse(write(view))).toEqual(view);
	});

	it("preserves params it does not own", () => {
		// `?case=<id>` deep-links a case's editor open. A filter change must not
		// drop it, or following a link and then filtering closes the case.
		expect(write(DEFAULT_VIEW_STATE, "case=tc_1")).toBe("case=tc_1");
	});

	it("drops a whitespace-only search rather than writing q=%20", () => {
		expect(
			write({
				...DEFAULT_VIEW_STATE,
				filters: { ...EMPTY_FILTERS, search: "   " },
			}),
		).toBe("");
	});
});

describe("shouldResetPage", () => {
	const at = (patch: Partial<TestCasesViewState>): TestCasesViewState => ({
		...DEFAULT_VIEW_STATE,
		page: 3,
		...patch,
	});

	it("resets when the matching set changes", () => {
		// Page 3 of a 5-page list becomes an empty table the moment a filter
		// narrows it to one page — the reader sees "no cases match" for a filter
		// that matched plenty.
		expect(
			shouldResetPage(
				at({}),
				at({ filters: { ...EMPTY_FILTERS, state: "READY" } }),
			),
		).toBe(true);
	});

	it("resets when the page size changes, because page 3 means something else", () => {
		expect(shouldResetPage(at({}), at({ pageSize: 100 }))).toBe(true);
	});

	it("does NOT reset on a re-sort — same rows, different order", () => {
		expect(
			shouldResetPage(at({}), at({ sort: "title", direction: "asc" })),
		).toBe(false);
	});

	it("does NOT reset on a plain page change", () => {
		expect(shouldResetPage(at({}), at({ page: 4 }))).toBe(false);
	});
});
