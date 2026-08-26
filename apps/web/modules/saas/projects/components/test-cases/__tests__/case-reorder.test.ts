import { describe, expect, it } from "vitest";
import {
	buildReorderPayload,
	canReorderCases,
	reorderBlocker,
} from "../case-reorder";

/**
 * Manual case reordering.
 *
 * `TestCase.order` is a **single global column per project**, while the list it is
 * dragged in is offset-paginated and filterable on nine dimensions. Every gate
 * here exists because dragging without it silently writes an order the reader did
 * not ask for — and the write succeeds, so nothing surfaces the mistake. These are
 * the tests for a feature whose failure mode is quiet.
 */

const OPEN = {
	sort: "order" as const,
	direction: "asc" as const,
	hasActiveFilters: false,
	hasNextPage: false,
	canEdit: true,
};

describe("reorderBlocker", () => {
	it("allows the one view where dragging means what it looks like", () => {
		expect(reorderBlocker(OPEN)).toBeNull();
	});

	it("blocks any other sort, because the drag would fight it", () => {
		// Dragging while sorted by priority either snaps back on the next fetch or
		// rewrites `order` invisibly. Neither is a reorder.
		for (const sort of ["priority", "recentRun", "title"] as const) {
			expect(reorderBlocker({ ...OPEN, sort })).toBe("SORT");
		}
	});

	it("blocks descending, because the writer numbers from the top", () => {
		// The payload numbers rows 0..n-1 top-to-bottom. Under `desc` that puts
		// the dragged row at the opposite end from where it was dropped.
		expect(reorderBlocker({ ...OPEN, direction: "desc" })).toBe(
			"DIRECTION",
		);
	});

	it("blocks a filtered view, because the rows are a subset", () => {
		// Renumbering a subset 0..n-1 assigns values that collide with the hidden
		// rows, so the unfiltered list comes back interleaved.
		expect(reorderBlocker({ ...OPEN, hasActiveFilters: true })).toBe(
			"FILTERED",
		);
	});

	it("blocks a partially loaded list, which is the same collision one page down", () => {
		expect(reorderBlocker({ ...OPEN, hasNextPage: true })).toBe(
			"NOT_ALL_LOADED",
		);
	});

	it("names the sort first when several gates fail at once", () => {
		// A reader told four things fixes none of them. The sort is the one that
		// makes the whole idea meaningful, so it is named first.
		expect(
			reorderBlocker({
				sort: "title",
				direction: "desc",
				hasActiveFilters: true,
				hasNextPage: true,
			}),
		).toBe("SORT");
	});

	it("never blames the view for a permission problem", () => {
		// The load-bearing reason permission is not part of this function. A
		// viewer whose sort is fine must not be told the sort is wrong — that
		// sends someone to change a setting that was never the problem.
		expect(reorderBlocker(OPEN)).toBeNull();
	});
});

describe("canReorderCases", () => {
	it("requires edit rights as well as a draggable view", () => {
		expect(canReorderCases(OPEN)).toBe(true);
		expect(canReorderCases({ ...OPEN, canEdit: false })).toBe(false);
	});

	it("is false whenever any single gate fails", () => {
		expect(canReorderCases({ ...OPEN, sort: "title" })).toBe(false);
		expect(canReorderCases({ ...OPEN, direction: "desc" })).toBe(false);
		expect(canReorderCases({ ...OPEN, hasActiveFilters: true })).toBe(
			false,
		);
		expect(canReorderCases({ ...OPEN, hasNextPage: true })).toBe(false);
	});
});

describe("buildReorderPayload", () => {
	it("renumbers the whole list, not just the moved row", () => {
		// Two cases can share an `order` today — nothing has ever written the
		// column — so nudging one value leaves the tie unresolved and the list
		// settles differently on the next read.
		expect(buildReorderPayload(["c", "a", "b"])).toEqual([
			{ id: "c", order: 0 },
			{ id: "a", order: 1 },
			{ id: "b", order: 2 },
		]);
	});

	it("produces a dense, gapless sequence from zero", () => {
		const payload = buildReorderPayload(["x", "y", "z", "w"]);

		expect(payload.map((p) => p.order)).toEqual([0, 1, 2, 3]);
	});

	it("handles an empty list without inventing a row", () => {
		expect(buildReorderPayload([])).toEqual([]);
	});
});
