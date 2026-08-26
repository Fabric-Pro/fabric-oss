import { describe, expect, it } from "vitest";
import { normalizeForComparison } from "./normalize-for-comparison";

describe("normalizeForComparison", () => {
	it("normalizes CRLF line endings to LF", () => {
		expect(normalizeForComparison("line one\r\nline two")).toBe(
			"line one\nline two",
		);
	});

	it("strips trailing whitespace per line", () => {
		expect(
			normalizeForComparison("line one  \nline two\t\nline three"),
		).toBe("line one\nline two\nline three");
	});

	it("collapses 3+ consecutive newlines into 2", () => {
		expect(normalizeForComparison("para one\n\n\npara two")).toBe(
			"para one\n\npara two",
		);
		expect(normalizeForComparison("para one\n\n\n\n\npara two")).toBe(
			"para one\n\npara two",
		);
	});

	it("preserves double newlines (paragraph breaks)", () => {
		expect(normalizeForComparison("para one\n\npara two")).toBe(
			"para one\n\npara two",
		);
	});

	it("trims leading and trailing whitespace", () => {
		expect(normalizeForComparison("\n\n  # Title\n\nBody.\n\n")).toBe(
			"# Title\n\nBody.",
		);
	});

	it("treats a trailing-whitespace-only difference as equal", () => {
		const original = "# Spec\n\n- item one\n- item two";
		const roundtripped = "# Spec  \n\n- item one \n- item two\t";
		expect(normalizeForComparison(roundtripped)).toBe(
			normalizeForComparison(original),
		);
	});

	it("treats HTML→Markdown roundtrip artifacts as equal", () => {
		// TipTap → Turndown roundtrips introduce CRLF, trailing spaces,
		// and extra blank lines without changing the actual content.
		const original = "# Title\n\nFirst paragraph.\n\nSecond paragraph.";
		const roundtripped =
			"# Title\r\n\r\n\r\nFirst paragraph.  \r\n\r\nSecond paragraph.\r\n";
		expect(normalizeForComparison(roundtripped)).toBe(
			normalizeForComparison(original),
		);
	});

	it("treats a real content change as unequal", () => {
		const original = "# Spec\n\n- item one\n- item two";
		const edited = "# Spec\n\n- item one\n- item two\n- item three";
		expect(normalizeForComparison(edited)).not.toBe(
			normalizeForComparison(original),
		);
	});

	it("treats a single-word edit as unequal", () => {
		expect(normalizeForComparison("The cat sat.")).not.toBe(
			normalizeForComparison("The dog sat."),
		);
	});

	it("does not collapse meaningful single newlines", () => {
		expect(normalizeForComparison("line one\nline two")).toBe(
			"line one\nline two",
		);
	});
});
