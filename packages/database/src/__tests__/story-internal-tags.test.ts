import { describe, expect, it } from "vitest";
import {
	isInternalStoryTag,
	mergeStoryMarkers,
	splitInternalStoryTags,
} from "../story-internal-tags";

describe("splitInternalStoryTags", () => {
	it("keeps PM-tool labels and moves phase/area/priority markers to tags", () => {
		expect(
			splitInternalStoryTags([
				"backend",
				"phase:1",
				"area:Vision & Intake",
				"priority:must",
				" security ",
			]),
		).toEqual({
			labels: ["backend", "security"],
			tags: ["phase:1", "area:Vision & Intake", "priority:must"],
		});
	});

	it("drops blanks and duplicates, tolerates null", () => {
		expect(
			splitInternalStoryTags(["a", "a", "", "phase:2", "phase:2"]),
		).toEqual({ labels: ["a"], tags: ["phase:2"] });
		expect(splitInternalStoryTags(null)).toEqual({ labels: [], tags: [] });
	});

	it("never lets a marker reach the PM label set", () => {
		for (const marker of ["phase:3", "area:X", "priority:nice"]) {
			expect(isInternalStoryTag(marker)).toBe(true);
			expect(splitInternalStoryTags([marker]).labels).toEqual([]);
		}
	});
});

describe("mergeStoryMarkers", () => {
	it("merges labels with tag rows or plain tag values, without duplicates", () => {
		expect(
			mergeStoryMarkers(["x"], [{ value: "phase:1" }, { value: "x" }]),
		).toEqual(["x", "phase:1"]);
		expect(mergeStoryMarkers(null, ["area:A"])).toEqual(["area:A"]);
		expect(mergeStoryMarkers(["x"], undefined)).toEqual(["x"]);
	});
});
