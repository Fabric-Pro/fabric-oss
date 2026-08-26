import { describe, expect, it } from "vitest";
import { normalizeTopicEnrichment } from "../publishing-suite-schema";

describe("normalizeTopicEnrichment", () => {
	it("drops unknown function tags and keeps valid ones (deduped)", () => {
		const out = normalizeTopicEnrichment({
			relevantFunctionTags: [
				"DEVELOPER",
				"WIZARD",
				"DEVELOPER",
				"DESIGNER",
			],
		});
		expect(out.relevantFunctionTags).toEqual(["DEVELOPER", "DESIGNER"]);
	});

	it("drops a post-type row with an unknown type, keeps valid rows, derives suggestedPostTypes", () => {
		const out = normalizeTopicEnrichment({
			postTypeRecommendations: [
				{ type: "Reel", theme: "x", rationale: "y" }, // unknown → dropped
				{ type: "Blog Post", theme: "deep dive", rationale: "big PR" },
				{ type: "Blog Post", theme: "dup", rationale: "dup" }, // dupe type → dropped
			],
		});
		expect(out.postTypeRecommendations).toEqual([
			{ type: "Blog Post", theme: "deep dive", rationale: "big PR" },
		]);
		expect(out.suggestedPostTypes).toEqual(["Blog Post"]);
	});

	it("caps theme and rationale length and tolerates missing/garbage input", () => {
		const out = normalizeTopicEnrichment({
			relevantFunctionTags: "not-an-array" as unknown,
			postTypeRecommendations: [
				{
					type: "Tweet",
					theme: "t".repeat(500),
					rationale: 42 as unknown,
				},
			],
		});
		expect(out.relevantFunctionTags).toEqual([]);
		expect(out.postTypeRecommendations[0].theme.length).toBe(120);
		expect(out.postTypeRecommendations[0].rationale).toBe("");
	});

	it("degrades to an empty shape instead of throwing on a null/undefined raw", () => {
		const empty = {
			relevantFunctionTags: [],
			postTypeRecommendations: [],
			suggestedPostTypes: [],
		};
		expect(() => normalizeTopicEnrichment(null as never)).not.toThrow();
		expect(normalizeTopicEnrichment(null as never)).toEqual(empty);
		expect(() =>
			normalizeTopicEnrichment(undefined as never),
		).not.toThrow();
		expect(normalizeTopicEnrichment(undefined as never)).toEqual(empty);
	});
});
