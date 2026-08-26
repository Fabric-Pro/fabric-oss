import { normalizeTopicEnrichment } from "@repo/database";
import { describe, expect, it } from "vitest";
import { LlmOutputSchema } from "../summarize-topic-suggestions";

describe("LlmOutputSchema — loose raw contract (fail-open, I4)", () => {
	it("accepts arbitrary post-type strings at the raw layer (normalization filters later)", () => {
		const r = LlmOutputSchema.safeParse({
			topics: [
				{
					title: "t",
					pitch: "p",
					provenance: {},
					postTypeRecommendations: [
						{ type: "Reel", theme: "x", rationale: "y" },
					],
				},
			],
		});
		expect(r.success).toBe(true); // raw layer no longer rejects — it's loose
	});
});

describe("normalizeTopicEnrichment — a novel post type is dropped, not fatal", () => {
	it("drops an off-whitelist type and keeps the valid ones", () => {
		const out = normalizeTopicEnrichment({
			postTypeRecommendations: [
				{ type: "Reel", theme: "x", rationale: "y" }, // was rejected before; now dropped
				{ type: "Tweet", theme: "punchy", rationale: "quick win" },
			],
		});
		expect(out.suggestedPostTypes).toEqual(["Tweet"]);
	});
});

describe("LlmOutputSchema / normalizeTopicEnrichment — null array elements (I4 fail-open)", () => {
	it("raw schema accepts a null element in either enrichment array", () => {
		const r = LlmOutputSchema.safeParse({
			topics: [
				{
					title: "t",
					pitch: "p",
					provenance: {},
					relevantFunctionTags: [null, "DEVELOPER"],
					postTypeRecommendations: [
						null,
						{ type: "Tweet", theme: "t", rationale: "r" },
					],
				},
			],
		});
		expect(r.success).toBe(true);
	});

	it("normalizeTopicEnrichment drops the null elements and keeps the valid ones", () => {
		const out = normalizeTopicEnrichment({
			relevantFunctionTags: [null, "DEVELOPER"],
			postTypeRecommendations: [
				null,
				{ type: "Tweet", theme: "t", rationale: "r" },
			],
		});
		expect(out.relevantFunctionTags).toEqual(["DEVELOPER"]);
		expect(out.postTypeRecommendations).toEqual([
			{ type: "Tweet", theme: "t", rationale: "r" },
		]);
		expect(out.suggestedPostTypes).toEqual(["Tweet"]);
	});
});
