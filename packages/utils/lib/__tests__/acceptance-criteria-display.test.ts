import { describe, expect, it } from "vitest";
import { criterionDisplayText } from "../acceptance-criteria";

/**
 * What a reader SEES, as opposed to what the drafter feeds a prompt.
 *
 * The stored text is deliberately raw markdown; the traceability matrix renders
 * it as text, so every Given/When/Then criterion arrived on screen with its
 * asterisks showing. These cases are the shapes actually observed in the matrix.
 */
describe("criterionDisplayText", () => {
	it("unwraps the Given/When/Then emphasis the matrix was showing raw", () => {
		expect(
			criterionDisplayText(
				"**Given** a feature ticket has acceptance criteria **When** the AI writes tests **Then** each test is tagged",
			),
		).toBe(
			"Given a feature ticket has acceptance criteria When the AI writes tests Then each test is tagged",
		);
	});

	/**
	 * Criteria synced from a PM tool can carry a trailing backlink. One matrix
	 * row ended in a literal `<p><a href="…">View in Fabric</a></p>`.
	 */
	it("strips an HTML backlink a PM sync appended", () => {
		expect(
			criterionDisplayText(
				'the AI warns that coverage is incomplete <p><a href="https://example.com/x">View in Fabric</a></p>',
			),
		).toBe("the AI warns that coverage is incomplete View in Fabric");
	});

	it("unwraps underscore emphasis and inline code", () => {
		expect(criterionDisplayText("__must__ return `null`")).toBe(
			"must return null",
		);
	});

	/**
	 * The conservative half. A lone asterisk is as likely to be a footnote
	 * marker or a literal in a spec as it is to be markdown, and eating it would
	 * silently change what the criterion says.
	 */
	it("leaves a lone asterisk alone", () => {
		expect(criterionDisplayText("charge 2 * the base rate")).toBe(
			"charge 2 * the base rate",
		);
		expect(criterionDisplayText("see the note below *")).toBe(
			"see the note below *",
		);
	});

	it("collapses the whitespace stripping tags leaves behind", () => {
		expect(criterionDisplayText("a <br/> b   c")).toBe("a b c");
	});

	it("returns plain text unchanged", () => {
		expect(
			criterionDisplayText("A valid promo code reduces the total."),
		).toBe("A valid promo code reduces the total.");
	});
});
