/**
 * Tests for the `deriveDiagramTitle` shared utility.
 *
 * Spec § 6.3 / FR-3 locks the title-derivation rule:
 *   - `userPromptText.trim().slice(0, 60)` when non-empty
 *   - `"Untitled diagram from chat"` otherwise (null / undefined /
 *     empty / whitespace-only)
 *
 * The same utility is reused by E2E fixtures so a regression in either
 * branch will surface here AND in the Playwright tests for Group G.
 */

import { describe, expect, it } from "vitest";
import {
	DERIVED_DIAGRAM_TITLE_MAX_LENGTH,
	deriveDiagramTitle,
	UNTITLED_DIAGRAM_TITLE,
} from "../deriveDiagramTitle";

describe("deriveDiagramTitle — fallback branch", () => {
	it("returns the fallback for null", () => {
		expect(deriveDiagramTitle({ userPromptText: null })).toBe(
			UNTITLED_DIAGRAM_TITLE,
		);
	});

	it("returns the fallback for undefined", () => {
		expect(deriveDiagramTitle({ userPromptText: undefined })).toBe(
			UNTITLED_DIAGRAM_TITLE,
		);
	});

	it("returns the fallback when the field is omitted entirely", () => {
		expect(deriveDiagramTitle({})).toBe(UNTITLED_DIAGRAM_TITLE);
	});

	it("returns the fallback for an empty string", () => {
		expect(deriveDiagramTitle({ userPromptText: "" })).toBe(
			UNTITLED_DIAGRAM_TITLE,
		);
	});

	it("returns the fallback for a whitespace-only string", () => {
		// Tabs, spaces, newlines — all should collapse to the fallback so
		// a diagram never gets a blank-looking title.
		expect(deriveDiagramTitle({ userPromptText: "   " })).toBe(
			UNTITLED_DIAGRAM_TITLE,
		);
		expect(deriveDiagramTitle({ userPromptText: "\t\n\r" })).toBe(
			UNTITLED_DIAGRAM_TITLE,
		);
	});
});

describe("deriveDiagramTitle — happy path", () => {
	it("returns the trimmed prompt when shorter than the cap", () => {
		expect(
			deriveDiagramTitle({ userPromptText: "  draw a flowchart  " }),
		).toBe("draw a flowchart");
	});

	it("returns exactly 60 characters when input is exactly 60", () => {
		const exact = "a".repeat(60);
		expect(deriveDiagramTitle({ userPromptText: exact })).toBe(exact);
		expect(deriveDiagramTitle({ userPromptText: exact }).length).toBe(60);
	});

	it("truncates to 60 characters when input is longer", () => {
		const longInput = "a".repeat(61);
		const result = deriveDiagramTitle({ userPromptText: longInput });
		expect(result.length).toBe(60);
		expect(result).toBe("a".repeat(60));
	});

	it("does not append an ellipsis (FR-3)", () => {
		// Spec explicitly forbids an "..." suffix; the truncation is
		// intentionally invisible.
		const longInput = "z".repeat(80);
		const result = deriveDiagramTitle({ userPromptText: longInput });
		expect(result.endsWith("...")).toBe(false);
		expect(result).toBe("z".repeat(60));
	});

	it("trims first, then truncates (leading whitespace doesn't eat the cap)", () => {
		// "   " (3 spaces) + 60 "x"s = 63 chars raw, but the 3 leading
		// spaces are trimmed before the slice -> result is 60 "x"s.
		const result = deriveDiagramTitle({
			userPromptText: `   ${"x".repeat(60)}`,
		});
		expect(result.length).toBe(60);
		expect(result).toBe("x".repeat(60));
	});

	it("preserves internal whitespace within the cap", () => {
		const result = deriveDiagramTitle({
			userPromptText: "  draw a flowchart of the login flow  ",
		});
		expect(result).toBe("draw a flowchart of the login flow");
	});

	it("returns a unicode-safe slice of length <= 60 code units", () => {
		// CJK / emoji prompts are valid input. We assert ONLY that the
		// result length stays at or below the 60 cap — the spec accepts
		// occasional surrogate clipping at the boundary (documented in
		// the source file's header).
		const cjk = "汉字".repeat(50); // 100 chars; well past the cap
		const result = deriveDiagramTitle({ userPromptText: cjk });
		expect(result.length).toBeLessThanOrEqual(
			DERIVED_DIAGRAM_TITLE_MAX_LENGTH,
		);
		// And the result is a prefix of the trimmed input, never empty.
		expect(result.length).toBeGreaterThan(0);
		expect(cjk.startsWith(result)).toBe(true);
	});
});

describe("deriveDiagramTitle — exported constants", () => {
	it("exposes the 60-char cap as a constant for callers", () => {
		expect(DERIVED_DIAGRAM_TITLE_MAX_LENGTH).toBe(60);
	});

	it("exposes the canonical fallback string", () => {
		expect(UNTITLED_DIAGRAM_TITLE).toBe("Untitled diagram from chat");
	});
});
