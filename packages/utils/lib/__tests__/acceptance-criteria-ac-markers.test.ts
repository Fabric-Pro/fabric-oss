import { describe, expect, it } from "vitest";
import { parseAcceptanceCriteria } from "../acceptance-criteria";

/**
 * Specs that number their criteria in prose rather than with list markers.
 *
 * Observed live: a feature with eight criteria written as consecutive `AC1 - …`
 * lines rendered ONE traceability row labelled "AC 1", carrying all eight
 * concatenated. Cases naming AC2..AC8 had no row to attach to, so 27 of 30 fell
 * into the unmapped bucket rather than showing eight coverage gaps.
 */
describe("AC-marker criteria", () => {
	it("splits consecutive AC markers with no bullets and no blank lines", () => {
		const parsed = parseAcceptanceCriteria(
			[
				"AC1 - A user can create a note.",
				"AC2 - A user can edit a note.",
				"AC3 - A user can delete a note.",
				"AC4 - Notes are scoped to the workspace.",
			].join("\n"),
		);
		expect(parsed).toHaveLength(4);
		expect(parsed[0]).toEqual({
			index: 1,
			text: "A user can create a note.",
		});
		expect(parsed[3].text).toBe("Notes are scoped to the workspace.");
	});

	/** The row is labelled "AC N" from its position, so keeping the marker in the text reads "AC 1  AC1 - …". */
	it("strips the marker from the criterion text", () => {
		const parsed = parseAcceptanceCriteria(
			"AC1 - A user can create a note.",
		);
		expect(parsed[0].text).toBe("A user can create a note.");
	});

	it("accepts the separator styles specs actually use", () => {
		for (const blob of [
			"AC1 - first\nAC2 - second",
			"AC 1: first\nAC 2: second",
			"AC1. first\nAC2. second",
			"AC1) first\nAC2) second",
			"ac1 — first\nac2 — second",
		]) {
			expect(parseAcceptanceCriteria(blob), blob).toHaveLength(2);
		}
	});

	it("strips the marker from a bulleted criterion too", () => {
		const parsed = parseAcceptanceCriteria(
			"- AC1 - A user can create a note.\n- AC2 - A user can edit a note.",
		);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].text).toBe("A user can create a note.");
	});

	it("folds a criterion's continuation lines into it", () => {
		const parsed = parseAcceptanceCriteria(
			[
				"AC1 - Given a note exists",
				"when the user opens it",
				"then the body is editable.",
				"AC2 - A deleted note is not listed.",
			].join("\n"),
		);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].text).toBe(
			"Given a note exists when the user opens it then the body is editable.",
		);
	});

	/**
	 * The guard against over-splitting. A criterion that cites another one reads
	 * "…consistent with AC 2" mid-sentence; splitting there would invent a row.
	 */
	it("does not split on a mid-sentence reference to another criterion", () => {
		const parsed = parseAcceptanceCriteria(
			"- The total must stay consistent with AC 2 after a refund.",
		);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].text).toBe(
			"The total must stay consistent with AC 2 after a refund.",
		);
	});

	/**
	 * Prose above the first marker is context, not criterion 1. Counted as one it
	 * takes row 1 and pushes AC1 to row 2, so a case tagged "AC 2" attaches to the
	 * row holding AC1's text — a confident wrong answer, which is worse than the
	 * unmapped bucket this parser exists to remove.
	 */
	it("does not count an intro sentence above the first marker", () => {
		const parsed = parseAcceptanceCriteria(
			"Context: users need offline support.\n\nAC1 - works offline\nAC2 - syncs when online",
		);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toEqual({ index: 1, text: "works offline" });
		expect(parsed[1].text).toBe("syncs when online");
	});

	/** A sentence that wraps just before a reference must keep its next line. */
	it("does not eat a line where a wrapped sentence starts with a reference", () => {
		const parsed = parseAcceptanceCriteria(
			"This total must remain consistent with\nAC 3.\nRefunds recompute the balance.",
		);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].text).toContain("AC 3.");
		expect(parsed[0].text).toContain("Refunds recompute the balance.");
	});

	/** An indented line continues the item above it, marker-shaped or not. */
	it("does not split on an indented continuation line", () => {
		const parsed = parseAcceptanceCriteria(
			"- Given a note exists\n  AC 2 - meant as continuation",
		);
		expect(parsed).toHaveLength(1);
	});

	/** A sub-bullet folds into a different row, so its reference is not noise. */
	it("keeps a sub-bullet's marker, which names another row", () => {
		const parsed = parseAcceptanceCriteria(
			"- Given a note exists\n  - AC 2 - when shared, permissions apply",
		);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].text).toContain("AC 2");
	});

	it("treats an escaped ordered marker as a list item", () => {
		// A markdown serializer writes `38\\.` when a list item has lost its
		// list role upstream. Without tolerating it the section collapses into
		// paragraph mode and every "AC N" reference shifts.
		const parsed = parseAcceptanceCriteria(
			"38\\. GIVEN no chat app is configured\n39\\. GIVEN chat setup is missing",
		);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].text).toContain("GIVEN no chat app is configured");
		expect(parsed[1].text).toContain("GIVEN chat setup is missing");
	});

	/** Shapes that already worked must keep working. */
	it("leaves bulleted and blank-separated specs alone", () => {
		expect(parseAcceptanceCriteria("- first\n- second")).toHaveLength(2);
		expect(
			parseAcceptanceCriteria("first\n\nsecond\n\nthird"),
		).toHaveLength(3);
	});
});

describe("bounded list-marker match (js/polynomial-redos)", () => {
	it("still parses a bulleted criterion comfortably within the bound", () => {
		const text = `- ${"x".repeat(1900)}`;
		const parsed = parseAcceptanceCriteria(text);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].text).toBe("x".repeat(1900));
	});

	it("returns a 5,000-char bulleted line in full — only the marker match is bounded, not the content", () => {
		const longLine = `- ${"x".repeat(5000)}`;
		const parsed = parseAcceptanceCriteria(longLine);
		expect(parsed).toHaveLength(1);
		// The bound applies only to detecting the `- ` marker itself; the
		// criterion text is read from the full, unsliced line, so nothing is
		// lost for a legitimately long criterion.
		expect(parsed[0].text).toBe("x".repeat(5000));
		expect(parsed[0].text.length).toBe(5000);
	});
});
