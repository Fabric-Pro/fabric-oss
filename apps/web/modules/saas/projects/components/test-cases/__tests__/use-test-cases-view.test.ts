import { describe, expect, it, vi } from "vitest";
import type { SortDirection, SortKey } from "../constants";

// The hook module imports the oRPC client only to build a query key inside the
// hook; the pure helpers under test never touch it. Stub it so importing the
// module stays side-effect free in the unit environment.
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

import {
	ALL,
	buildTestCasesListInput,
	EMPTY_FILTERS,
	hasActiveFilters,
	type TestCasesFilters,
	toBulkFilter,
} from "../use-test-cases-view";

function build(
	filters: Partial<TestCasesFilters>,
	sort: SortKey = "order",
	direction: SortDirection = "asc",
) {
	return buildTestCasesListInput({
		projectId: "p1",
		organizationId: null,
		filters: { ...EMPTY_FILTERS, ...filters },
		sort,
		direction,
	});
}

describe("buildTestCasesListInput", () => {
	it("drops empty search and ALL filters so they leave the query input", () => {
		expect(build({ search: "   " })).toEqual({
			projectId: "p1",
			organizationId: null,
			sort: "order",
			direction: "asc",
		});
	});

	it("includes a trimmed search and concrete enum filters", () => {
		expect(
			buildTestCasesListInput({
				projectId: "p1",
				organizationId: "org_1",
				filters: {
					...EMPTY_FILTERS,
					search: "  login ",
					state: "READY",
					priority: "HIGH",
					tag: "smoke",
				},
				sort: "title",
				direction: "asc",
			}),
		).toEqual({
			projectId: "p1",
			organizationId: "org_1",
			search: "login",
			state: "READY",
			priority: "HIGH",
			tag: "smoke",
			sort: "title",
			direction: "asc",
		});
	});

	it("keeps a multi-word tag intact and trims it only at the query boundary", () => {
		// Regression: the input trimmed on every keystroke against a controlled
		// field, so typing "smoke test" ate the space and produced "smoket" —
		// any tag containing a space was unreachable through the filter.
		expect(
			buildTestCasesListInput({
				projectId: "p1",
				organizationId: null,
				filters: { ...EMPTY_FILTERS, tag: "  smoke test  " },
				sort: null,
				direction: "asc",
			}).tag,
		).toBe("smoke test");
	});

	it("omits a whitespace-only tag entirely", () => {
		expect(
			buildTestCasesListInput({
				projectId: "p1",
				organizationId: null,
				filters: { ...EMPTY_FILTERS, tag: "   " },
				sort: null,
				direction: "asc",
			}).tag,
		).toBeUndefined();
	});

	it("preserves a null organizationId for the personal context (XOR)", () => {
		const input = build({ state: "DRAFT" });
		expect(input.organizationId).toBeNull();
		expect(input.state).toBe("DRAFT");
		expect("priority" in input).toBe(false);
	});

	it("carries the plan, automation, result and coverage filters", () => {
		expect(
			build({
				planId: "plan_1",
				automationStatus: "AUTOMATED",
				currentResult: "FAILED",
				linkedStoryId: "story_1",
			}),
		).toMatchObject({
			planId: "plan_1",
			automationStatus: "AUTOMATED",
			currentResult: "FAILED",
			linkedStoryId: "story_1",
		});
	});

	it("keeps externalLinked=false — it is a filter, not an absent one", () => {
		expect(build({ externalLinked: false }).externalLinked).toBe(false);
		expect(build({ externalLinked: true }).externalLinked).toBe(true);
		expect("externalLinked" in build({ externalLinked: ALL })).toBe(false);
	});

	it("always sends sort and direction so ordering is applied server-side", () => {
		expect(build({}, "priority", "desc")).toMatchObject({
			sort: "priority",
			direction: "desc",
		});
	});
});

describe("toBulkFilter", () => {
	it("drops addressing and ordering, keeping only the predicate", () => {
		const input = buildTestCasesListInput({
			projectId: "p1",
			organizationId: "org_1",
			filters: { ...EMPTY_FILTERS, search: "login", state: "READY" },
			sort: "priority",
			direction: "desc",
		});

		expect(toBulkFilter(input)).toEqual({
			search: "login",
			state: "READY",
		});
	});

	it("is empty for an unfiltered list — 'all matching' means the whole project", () => {
		expect(toBulkFilter(build({}))).toEqual({});
	});

	it("re-orders without changing which cases match", () => {
		const ascending = build({ state: "READY" }, "title", "asc");
		const descending = build({ state: "READY" }, "title", "desc");

		expect(toBulkFilter(ascending)).toEqual(toBulkFilter(descending));
	});

	it("round-trips every predicate the list applied", () => {
		const input = build({
			search: "login",
			state: "READY",
			priority: "HIGH",
			tag: "smoke",
			linkedStoryId: "story_1",
			planId: "plan_1",
			automationStatus: "AUTOMATED",
			currentResult: "FAILED",
			externalLinked: false,
		});

		expect(toBulkFilter(input)).toEqual({
			search: "login",
			state: "READY",
			priority: "HIGH",
			tag: "smoke",
			linkedStoryId: "story_1",
			planId: "plan_1",
			automationStatus: "AUTOMATED",
			currentResult: "FAILED",
			externalLinked: false,
		});
	});
});

describe("hasActiveFilters", () => {
	it("is false for the unset toolbar", () => {
		expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
	});

	it("ignores a whitespace-only search — that is still no search", () => {
		expect(hasActiveFilters({ ...EMPTY_FILTERS, search: "   " })).toBe(
			false,
		);
	});

	// One case per filter — each must be enough on its own to offer "Clear".
	const SET_ONE: [keyof TestCasesFilters, Partial<TestCasesFilters>][] = [
		["search", { search: "login" }],
		["state", { state: "READY" }],
		["priority", { priority: "HIGH" }],
		["tag", { tag: "smoke" }],
		["linkedStoryId", { linkedStoryId: "story_1" }],
		["planId", { planId: "plan_1" }],
		["automationStatus", { automationStatus: "AUTOMATED" }],
		["currentResult", { currentResult: "FAILED" }],
		["externalLinked", { externalLinked: true }],
	];

	it.each(SET_ONE)("is true when %s alone is set", (_key, filter) => {
		expect(hasActiveFilters({ ...EMPTY_FILTERS, ...filter })).toBe(true);
	});

	it("counts externalLinked=false — 'not linked' is a filter, not an absent one", () => {
		expect(
			hasActiveFilters({ ...EMPTY_FILTERS, externalLinked: false }),
		).toBe(true);
	});

	it("has a case for every filter the toolbar can set", () => {
		// Reads the REAL EMPTY_FILTERS, so a 10th filter fails here until it
		// gets a case above — the cases can't quietly fall behind the type.
		expect(SET_ONE.map(([key]) => key).sort()).toEqual(
			Object.keys(EMPTY_FILTERS).sort(),
		);
	});
});
