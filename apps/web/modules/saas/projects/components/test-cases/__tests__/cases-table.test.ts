import { describe, expect, it } from "vitest";
import {
	PAGE_GAP,
	pageCount,
	pageRange,
	paginationPages,
} from "../cases-table";

describe("pageCount", () => {
	it("never drops below one, so the footer always reads", () => {
		expect(pageCount(0, 50)).toBe(1);
	});

	it("rounds a partial last page up", () => {
		expect(pageCount(101, 50)).toBe(3);
		expect(pageCount(100, 50)).toBe(2);
	});

	it("survives a zero page size rather than dividing by it", () => {
		expect(pageCount(10, 0)).toBe(10);
	});
});

describe("pageRange", () => {
	it("reports the 1-based range on screen", () => {
		expect(pageRange(1, 50, 214)).toEqual({ from: 1, to: 50 });
		expect(pageRange(3, 50, 214)).toEqual({ from: 101, to: 150 });
	});

	it("clamps the last page to the real total", () => {
		expect(pageRange(5, 50, 214)).toEqual({ from: 201, to: 214 });
	});

	it("is null for an empty set — '1–0 of 0' says less than nothing", () => {
		expect(pageRange(1, 50, 0)).toBeNull();
	});

	it("is null past the end, which is what a stale shared link produces", () => {
		expect(pageRange(9, 50, 214)).toBeNull();
	});
});

describe("paginationPages", () => {
	it("offers nothing to page through when there is one page or none", () => {
		expect(paginationPages(1, 1)).toEqual([1]);
		expect(paginationPages(1, 0)).toEqual([]);
	});

	it("lists every page while they still fit", () => {
		expect(paginationPages(1, 5)).toEqual([1, 2, 3, 4, 5]);
	});

	it("always keeps the first and last page reachable", () => {
		const tokens = paginationPages(10, 20);
		expect(tokens[0]).toBe(1);
		expect(tokens.at(-1)).toBe(20);
		expect(tokens).toContain(10);
	});

	it("collapses a long stretch into a single gap", () => {
		expect(paginationPages(10, 20)).toEqual([
			1,
			PAGE_GAP,
			9,
			10,
			11,
			PAGE_GAP,
			20,
		]);
	});

	it("shows a lone skipped page instead of hiding it behind an ellipsis", () => {
		// "1 … 3 4 5" costs the same width as "1 2 3 4 5" and tells the reader
		// less, so a gap of exactly one collapses to the page itself.
		expect(paginationPages(4, 6)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("never emits a page outside the range", () => {
		for (const page of [1, 2, 19, 20]) {
			for (const token of paginationPages(page, 20)) {
				if (token !== PAGE_GAP) {
					expect(token).toBeGreaterThanOrEqual(1);
					expect(token).toBeLessThanOrEqual(20);
				}
			}
		}
	});

	it("emits each page at most once", () => {
		const tokens = paginationPages(2, 20).filter((t) => t !== PAGE_GAP);
		expect(new Set(tokens).size).toBe(tokens.length);
	});
});
