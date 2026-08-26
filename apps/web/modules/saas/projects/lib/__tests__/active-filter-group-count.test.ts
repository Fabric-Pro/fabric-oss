import { describe, expect, it } from "vitest";
import {
	activeFilterGroupCount,
	activeMoreFilterCount,
	EMPTY_ROADMAP_FILTERS,
} from "../roadmap-filters";

describe("activeFilterGroupCount", () => {
	it("returns 0 for the empty filter object", () => {
		expect(activeFilterGroupCount(EMPTY_ROADMAP_FILTERS)).toBe(0);
	});

	it("ignores the free-text search (surfaced in the bar, not the panel)", () => {
		expect(
			activeFilterGroupCount({ ...EMPTY_ROADMAP_FILTERS, q: "auth" }),
		).toBe(0);
	});

	it("counts a multi-select dimension once regardless of value count", () => {
		expect(
			activeFilterGroupCount({
				...EMPTY_ROADMAP_FILTERS,
				kind: ["BUG", "FEATURE"],
			}),
		).toBe(1);
	});

	it("counts each active date range once (either bound)", () => {
		expect(
			activeFilterGroupCount({
				...EMPTY_ROADMAP_FILTERS,
				createdFrom: "2026-05-01",
			}),
		).toBe(1);
		expect(
			activeFilterGroupCount({
				...EMPTY_ROADMAP_FILTERS,
				updatedFrom: "2026-05-01",
				updatedTo: "2026-05-31",
			}),
		).toBe(1);
	});

	it("counts each active flag / recency window once", () => {
		expect(
			activeFilterGroupCount({
				...EMPTY_ROADMAP_FILTERS,
				missingDesc: true,
				missingAc: true,
				recentlyApproved: 7,
				recentlyAdded: 30,
				recentlyChanged: 90,
			}),
		).toBe(5);
	});

	it("sums every distinct active group", () => {
		expect(
			activeFilterGroupCount({
				...EMPTY_ROADMAP_FILTERS,
				kind: ["BUG"],
				priority: ["P0_CRITICAL"],
				stage: ["DONE"],
				sync: ["synced"],
				source: ["jira"],
				createdFrom: "2026-05-01",
				updatedTo: "2026-05-31",
				syncedFrom: "2026-05-10",
				missingDesc: true,
				missingAc: true,
				recentlyApproved: 7,
				recentlyAdded: 30,
				recentlyChanged: 90,
			}),
		).toBe(13);
	});
});

describe("activeMoreFilterCount", () => {
	it("returns 0 for the empty filter object", () => {
		expect(activeMoreFilterCount(EMPTY_ROADMAP_FILTERS)).toBe(0);
	});

	it("ignores the primary facets (kind / priority / stage) and search", () => {
		expect(
			activeMoreFilterCount({
				...EMPTY_ROADMAP_FILTERS,
				q: "auth",
				kind: ["BUG"],
				priority: ["P0_CRITICAL"],
				stage: ["DONE"],
			}),
		).toBe(0);
	});

	it("counts only the secondary groups (sync / source / dates / flags)", () => {
		expect(
			activeMoreFilterCount({
				...EMPTY_ROADMAP_FILTERS,
				// primary — must NOT be counted
				kind: ["BUG"],
				stage: ["DONE"],
				// secondary — each counts once
				sync: ["synced"],
				source: ["jira"],
				createdFrom: "2026-05-01",
				updatedTo: "2026-05-31",
				syncedFrom: "2026-05-10",
				missingDesc: true,
				missingAc: true,
				recentlyApproved: 7,
				recentlyAdded: 30,
				recentlyChanged: 90,
			}),
		).toBe(10);
	});
});
