import { describe, expect, it } from "vitest";
import { pageCount, pageRange } from "../cases-table";

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
