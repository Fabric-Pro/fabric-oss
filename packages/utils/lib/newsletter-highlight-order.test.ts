import { describe, expect, it } from "vitest";
import {
	effectiveHighlightIndexes,
	orderNewsletterHighlights,
} from "./newsletter-highlight-order";

const highlights = ["a", "b", "c", "d"];

describe("orderNewsletterHighlights", () => {
	it("keeps the natural order when there is no order and nothing removed", () => {
		expect(orderNewsletterHighlights(highlights, [], null)).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});

	it("applies a full order", () => {
		expect(orderNewsletterHighlights(highlights, [], [3, 2, 1, 0])).toEqual(
			["d", "c", "b", "a"],
		);
	});

	it("applies the order first, then drops removed highlights", () => {
		expect(
			orderNewsletterHighlights(highlights, [1], [1, 3, 0, 2]),
		).toEqual(["d", "a", "c"]);
	});

	it("appends highlights a partial order leaves out, in their natural order", () => {
		expect(orderNewsletterHighlights(highlights, [], [2])).toEqual([
			"c",
			"a",
			"b",
			"d",
		]);
		expect(orderNewsletterHighlights(highlights, [0], [3, 1])).toEqual([
			"d",
			"b",
			"c",
		]);
	});

	it.each([
		["not an array", "3,2,1,0"],
		["an out-of-range index", [0, 9]],
		["a negative index", [-1, 0]],
		["a duplicate", [1, 1]],
		["a fraction", [0.5]],
		["a non-number", ["1"]],
	])(
		"ignores an order with %s and uses the natural order",
		(_label, order) => {
			expect(orderNewsletterHighlights(highlights, [2], order)).toEqual([
				"a",
				"b",
				"d",
			]);
		},
	);

	it("ignores out-of-range removals", () => {
		expect(orderNewsletterHighlights(highlights, [7, -1], [1])).toEqual([
			"b",
			"a",
			"c",
			"d",
		]);
	});

	it("returns nothing when every highlight is removed", () => {
		expect(
			orderNewsletterHighlights(highlights, [0, 1, 2, 3], [3, 2]),
		).toEqual([]);
	});

	it("does not change the array it is given", () => {
		const input = [...highlights];
		orderNewsletterHighlights(input, [0], [3, 2, 1, 0]);
		expect(input).toEqual(highlights);
	});
});

describe("effectiveHighlightIndexes", () => {
	it("returns the indexes into the original array", () => {
		expect(effectiveHighlightIndexes(4, [0], [2, 0, 3])).toEqual([2, 3, 1]);
	});

	it("handles no highlights", () => {
		expect(effectiveHighlightIndexes(0, [], [0])).toEqual([]);
	});
});
