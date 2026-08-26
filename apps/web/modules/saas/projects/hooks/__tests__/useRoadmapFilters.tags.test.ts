import { describe, expect, it } from "vitest";
import { computeTagsRemovalPatch } from "../tags-filter-patch";

describe("computeTagsRemovalPatch", () => {
	it("removing one of many keeps AND when >=2 remain", () => {
		expect(computeTagsRemovalPatch(["a", "b", "c"], "c", "AND")).toEqual({
			tags: ["a", "b"],
		});
	});
	it("dropping below 2 resets tagsLogic to OR", () => {
		expect(computeTagsRemovalPatch(["a", "b"], "b", "AND")).toEqual({
			tags: ["a"],
			tagsLogic: "OR",
		});
	});
	it("clearing all (no value) resets to OR", () => {
		expect(computeTagsRemovalPatch(["a", "b"], undefined, "AND")).toEqual({
			tags: [],
			tagsLogic: "OR",
		});
	});
});
