/**
 * How a Living Memory sync's left-out paths sit inside its selected paths
 * (Fizzy #2750 §5.2, §5.3): whole segments, case-sensitive, strictly inside.
 */
import { describe, expect, it } from "vitest";
import {
	firstExcludedPathOutsideSelection,
	isStrictlyInsideContextSyncPath,
} from "../prisma/queries/projects/context-repository-sync-selection";

describe("isStrictlyInsideContextSyncPath", () => {
	it.each([
		["docs", "docs/drafts", true],
		["docs", "docs/a/b.md", true],
		["", "docs", true],
		["", "a.md", true],
		["docs", "docs", false],
		["", "", false],
		["docs", "docs-archive/a.md", false],
		["docs", "Docs/drafts", false],
		["docs/drafts", "docs", false],
	])("%j contains %j: %s", (outer, inner, expected) => {
		expect(isStrictlyInsideContextSyncPath(outer, inner)).toBe(expected);
	});
});

describe("firstExcludedPathOutsideSelection", () => {
	it("is null when every left-out path is inside a selected one", () => {
		expect(
			firstExcludedPathOutsideSelection(
				["docs", "notes"],
				["docs/drafts", "notes/old.md"],
			),
		).toBeNull();
		expect(firstExcludedPathOutsideSelection(["docs"], [])).toBeNull();
	});

	it("names the first one that is outside, or equal to, a selected path", () => {
		expect(
			firstExcludedPathOutsideSelection(
				["docs"],
				["docs/drafts", "notes/old.md", "other"],
			),
		).toBe("notes/old.md");
		expect(
			firstExcludedPathOutsideSelection(["docs/drafts"], ["docs/drafts"]),
		).toBe("docs/drafts");
	});
});
