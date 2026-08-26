import { describe, expect, it } from "vitest";
import { applyRemovedHighlights } from "../newsletter-highlight-filter";

const base = {
	schemaVersion: 1 as const,
	headline: "h",
	intro: "i",
	hasMajorFeatures: true,
	highlights: [
		{ title: "a", description: "da" },
		{ title: "b", description: "db" },
		{ title: "c", description: "dc" },
	],
};

describe("applyRemovedHighlights", () => {
	it("drops highlights at the given indexes", () => {
		const out = applyRemovedHighlights(base, [1]);
		expect(out.highlights.map((h) => h.title)).toEqual(["a", "c"]);
		expect(out.hasMajorFeatures).toBe(true);
	});
	it("ignores out-of-range / duplicate indexes", () => {
		const out = applyRemovedHighlights(base, [1, 1, 9, -1]);
		expect(out.highlights.map((h) => h.title)).toEqual(["a", "c"]);
	});
	it("sets hasMajorFeatures false when all removed", () => {
		const out = applyRemovedHighlights(base, [0, 1, 2]);
		expect(out.highlights).toEqual([]);
		expect(out.hasMajorFeatures).toBe(false);
	});
});
