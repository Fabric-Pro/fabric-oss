import { describe, expect, it } from "vitest";
import { countWords, formatWordCount } from "../word-count";

describe("countWords", () => {
	it("combines title + description into one count", () => {
		expect(countWords("Two words", "three more words here")).toBe(6);
	});

	it("returns 0 for empty title and description", () => {
		expect(countWords("", "")).toBe(0);
		expect(countWords("   ", "  ")).toBe(0);
	});

	it("collapses arbitrary whitespace/newlines between tokens", () => {
		expect(countWords("a\n\nb", "c\t d")).toBe(4);
	});

	it("counts markdown syntax tokens as-is (no stripping in v1)", () => {
		expect(countWords("# Heading", "- bullet **bold**")).toBe(5);
	});
});

describe("formatWordCount", () => {
	it("renders 0 words / 1 word / N words", () => {
		expect(formatWordCount(0)).toBe("0 words");
		expect(formatWordCount(1)).toBe("1 word");
		expect(formatWordCount(42)).toBe("42 words");
	});
});
