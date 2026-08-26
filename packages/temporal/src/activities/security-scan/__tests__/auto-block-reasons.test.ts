import { describe, expect, it } from "vitest";
import { computeAutoBlockReasons } from "../scan-activities";

describe("computeAutoBlockReasons — BLOCK-mode auto-block grouping", () => {
	it("ignores findings not tied to a work item", () => {
		expect(
			computeAutoBlockReasons([
				{ storyId: null, severity: "HIGH", title: "Loose finding" },
				{ storyId: undefined, severity: "LOW", title: "Another" },
			]),
		).toEqual([]);
	});

	it("blocks one story with its single finding's title", () => {
		const out = computeAutoBlockReasons([
			{ storyId: "s1", severity: "MEDIUM", title: "Missing alt text" },
		]);
		expect(out).toEqual([
			{
				storyId: "s1",
				reason: "Missing alt text — auto-blocked by the security & accessibility scan",
			},
		]);
	});

	it("uses the highest-severity finding's title and counts the rest", () => {
		const out = computeAutoBlockReasons([
			{ storyId: "s1", severity: "LOW", title: "Low one" },
			{ storyId: "s1", severity: "CRITICAL", title: "Critical one" },
			{ storyId: "s1", severity: "MEDIUM", title: "Medium one" },
		]);
		expect(out).toEqual([
			{
				storyId: "s1",
				reason: "Critical one (+2 more findings) — auto-blocked by the security & accessibility scan",
			},
		]);
	});

	it("singularizes the count for exactly two findings", () => {
		const out = computeAutoBlockReasons([
			{ storyId: "s1", severity: "HIGH", title: "Top" },
			{ storyId: "s1", severity: "LOW", title: "Other" },
		]);
		expect(out[0].reason).toBe(
			"Top (+1 more finding) — auto-blocked by the security & accessibility scan",
		);
	});

	it("returns one entry per distinct story", () => {
		const out = computeAutoBlockReasons([
			{ storyId: "s1", severity: "HIGH", title: "A" },
			{ storyId: "s2", severity: "LOW", title: "B" },
		]);
		expect(out.map((b) => b.storyId).sort()).toEqual(["s1", "s2"]);
	});
});
