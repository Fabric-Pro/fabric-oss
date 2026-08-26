import { describe, expect, it } from "vitest";
import { linkStateKey } from "../prisma/queries/projects/meeting-action-item-links";

describe("linkStateKey", () => {
	it("joins the item key and story id", () => {
		expect(linkStateKey("abc", "story_1")).toBe("abc:story_1");
	});

	it("distinguishes the same story on different items", () => {
		expect(linkStateKey("item_a", "s1")).not.toBe(
			linkStateKey("item_b", "s1"),
		);
	});

	it("distinguishes different stories on the same item", () => {
		expect(linkStateKey("item_a", "s1")).not.toBe(
			linkStateKey("item_a", "s2"),
		);
	});

	it("cannot be ambiguous, because item keys are fixed-length hex", () => {
		// A naive `a + b` concatenation would make ("ab","c") and ("a","bc")
		// collide. Item keys are always 64-char sha256 hex (computeActionItemKey),
		// so the single separator is unambiguous in practice — this pins the
		// separator so a future refactor cannot quietly drop it.
		expect(linkStateKey("a", "bc")).not.toBe(linkStateKey("ab", "c"));
	});
});
