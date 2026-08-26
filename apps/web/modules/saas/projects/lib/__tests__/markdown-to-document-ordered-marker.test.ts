/**
 * Exports read the stored spec markdown directly, so they must tolerate an
 * ordered marker whose period a markdown serializer escaped (`38\. GIVEN …`).
 * Without this the line falls through to the plain-paragraph branch and the
 * backslash is printed literally in the PDF/DOCX.
 */
import { describe, expect, it } from "vitest";
import {
	normalizeOrderedMarkerEscape,
	ORDERED_ITEM_LINE_RE,
} from "../markdown-to-document";

describe("ordered marker escape handling in exports", () => {
	it("recognises an escaped ordered marker as a list line", () => {
		expect(ORDERED_ITEM_LINE_RE.test("38\\. GIVEN a condition")).toBe(true);
		expect(ORDERED_ITEM_LINE_RE.test("38. GIVEN a condition")).toBe(true);
	});

	it("does not treat prose or bullets as ordered items", () => {
		expect(ORDERED_ITEM_LINE_RE.test("- GIVEN a condition")).toBe(false);
		expect(ORDERED_ITEM_LINE_RE.test("See item 38. for details")).toBe(
			false,
		);
	});

	it("strips the marker when rendering the item text", () => {
		expect(
			"38\\. GIVEN a condition".replace(ORDERED_ITEM_LINE_RE, ""),
		).toBe("GIVEN a condition");
	});

	it("drops the backslash from an escaped marker", () => {
		expect(normalizeOrderedMarkerEscape("38\\. GIVEN a condition")).toBe(
			"38. GIVEN a condition",
		);
	});

	it("leaves an unescaped marker and ordinary prose untouched", () => {
		expect(normalizeOrderedMarkerEscape("38. GIVEN a condition")).toBe(
			"38. GIVEN a condition",
		);
		expect(normalizeOrderedMarkerEscape("See item 38\\. here")).toBe(
			"See item 38\\. here",
		);
	});
});
